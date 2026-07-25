// Phase 11 — the router. Given a capability (and optional constraints), pick the
// best agent to do a job: highest Proof Score, cheapest, least loaded — respecting
// the paying agent's budget allow-list. This is the primitive auto-routing, the
// self-assembling planner, subcontracting, and quorum-by-default all build on.

import { getDb } from "./db";
import { searchAgents } from "./agents";
import { getBudget } from "./budgets";
import { parsePaymentAmount } from "./solana";
import type { Agent } from "@/sdk/types";

export interface RouteOptions {
  /** A single capability the worker must have. */
  capability?: string;
  /** Multiple capabilities — the worker must have ALL of them. */
  capabilities?: string[];
  /** Price ceiling, e.g. "0.50 USDC". Free agents always pass. */
  maxPrice?: string;
  /** The paying identity. Its budget allow-list is honoured, and it's never routed to itself. */
  fromAgent?: string;
  /** Agent ids to skip (already-hired, the parent chain, etc.). */
  exclude?: string[];
  /** How many candidates to weigh before ranking. Default 12. */
  candidateLimit?: number;
}

export interface Candidate {
  agent: Agent;
  /** 0–1000. Falls back to reputation×100 for agents not yet Proof-scored. */
  proofScore: number;
  /** Price magnitude in its own units; 0 for free-lane agents. */
  price: number;
  /** Live load: tasks currently running or queued for this agent. */
  load: number;
  /** Composite score, 0–1, blended across the candidate set. */
  score: number;
}

export interface RouteResult {
  agent: Agent;
  score: number;
  /** Human-readable why-this-one, e.g. "Proof 951 · 0.15 USDC · load 0". */
  reason: string;
  /** How many candidates were weighed. */
  considered: number;
}

// Weights: Proof Score dominates (a proven worker is worth more than a cheap or
// idle one), price next, live load last as a tie-shaper so work spreads out.
const W_PROOF = 0.6;
const W_PRICE = 0.25;
const W_LOAD = 0.15;

function proofOf(a: Agent): number {
  if (typeof a.proofScore === "number") return a.proofScore;
  // reputation is 0–10; scale to the 0–1000 Proof Score space as a fallback so
  // un-scored agents still rank sensibly until the recompute backfills them.
  return Math.round(((a as { reputation?: number }).reputation ?? 0) * 100);
}

function priceOf(a: Agent): number {
  if (!a.price) return 0;
  const p = parsePaymentAmount(a.price);
  return p ? p.amount : 0;
}

function loadOf(db: ReturnType<typeof getDb>, agentId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE to_agent = ? AND status IN ('running', 'queued', 'payment_pending')")
    .get(agentId) as { n: number };
  return row.n;
}

// Gateway providers are registered as ordinary priced agents but are driven
// synchronously in the HTTP layer — the worker never runs their queued tasks
// (workers/index.ts). Routing a paid hire to one would escrow funds against a task
// that never executes and never refunds, so they must never be routable.
function gatewayAgentIds(db: ReturnType<typeof getDb>): Set<string> {
  try {
    return new Set(
      (db.prepare("SELECT provider_id FROM gateway_providers").all() as { provider_id: string }[]).map((r) => r.provider_id),
    );
  } catch {
    return new Set();
  }
}

/**
 * Rank the eligible agents for a job, best first. Reused by selectAgent (top 1)
 * and quorum-by-default (top N). Returns [] when nothing qualifies.
 */
export function rankAgents(opts: RouteOptions): Candidate[] {
  const db = getDb();

  const pool = searchAgents({
    capability: opts.capability,
    capabilities: opts.capabilities,
    maxPrice: opts.maxPrice,
    sort: "proven",
    limit: opts.candidateLimit ?? 12,
  });

  // Eligibility: not the caller, not excluded, and — if the caller has a budget
  // with an allow-list — only agents that list allows. This is where spending
  // authority shapes routing (an autonomous agent can only be routed to
  // counterparties its owner approved).
  const exclude = new Set([...(opts.exclude ?? []), ...(opts.fromAgent ? [opts.fromAgent] : [])]);
  const gatewayIds = gatewayAgentIds(db);
  let allowed: Set<string> | null = null;
  if (opts.fromAgent) {
    const budget = getBudget(opts.fromAgent);
    // A defined allow-list is enforced even when empty — an empty list means
    // "no counterparties approved", matching checkBudget (which rejects any
    // target not in the list). Only an absent list (null) means "any agent".
    if (budget?.allowedToAgents) {
      allowed = new Set(budget.allowedToAgents);
    }
  }

  const eligible = pool.filter(
    (a) => !exclude.has(a.agentId) && !gatewayIds.has(a.agentId) && (!allowed || allowed.has(a.agentId)),
  );
  if (eligible.length === 0) return [];

  const rows = eligible.map((agent) => ({
    agent,
    proofScore: proofOf(agent),
    price: priceOf(agent),
    load: loadOf(db, agent.agentId),
  }));

  // Normalise each signal across the candidate set so the blend is comparable.
  const maxPrice = Math.max(...rows.map((r) => r.price), 0);
  const maxLoad = Math.max(...rows.map((r) => r.load), 0);

  const scored: Candidate[] = rows.map((r) => {
    const nProof = r.proofScore / 1000;
    const nPriceGood = maxPrice > 0 ? 1 - r.price / maxPrice : 1; // cheaper → higher
    const nLoadGood = maxLoad > 0 ? 1 - r.load / maxLoad : 1; // idler → higher
    const score = W_PROOF * nProof + W_PRICE * nPriceGood + W_LOAD * nLoadGood;
    return { ...r, score };
  });

  // Best first; ties broken by Proof Score, then by lighter load.
  scored.sort((a, b) => b.score - a.score || b.proofScore - a.proofScore || a.load - b.load);
  return scored;
}

/**
 * Pick the single best agent for a job. Returns null when nothing qualifies
 * (no capability match, all excluded, or none on the budget allow-list).
 */
export function selectAgent(opts: RouteOptions): RouteResult | null {
  const ranked = rankAgents(opts);
  if (ranked.length === 0) return null;
  const top = ranked[0];
  const priceLabel = top.agent.price || "free";
  return {
    agent: top.agent,
    score: Math.round(top.score * 1000) / 1000,
    reason: `Proof ${top.proofScore} · ${priceLabel} · load ${top.load}`,
    considered: ranked.length,
  };
}
