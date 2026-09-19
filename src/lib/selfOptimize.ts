// Phase 11 — self-optimization. An agent reads its own task history and adjusts
// its own price: raise when it's proven and in demand, lower when it's losing
// work or idle. Deterministic (no model needed), so it's predictable and testable;
// the model-driven re-describe/re-scope is a natural extension on top.

import { getTasksByAgent } from "./tasks";
import { getAgentById, updateAgent } from "./agents";
import { parsePaymentAmount, formatEth } from "./money";

export interface OptimizationMetrics {
  completed: number;
  failed: number;
  successRate: number;  // 0–1 over terminal tasks
  recentVolume: number; // tasks received in the last 7 days
  load: number;         // running + queued right now
}

export interface Optimization {
  agentId: string;
  currentPrice: string | null;
  suggestedPrice: string | null;
  action: "raise" | "lower" | "hold";
  rationale: string;
  metrics: OptimizationMetrics;
}

// A price floor and a step, both in wei. The old pair were tuned to USDC cents: a 0.0001 floor and
// four-decimal rounding would sit at or above most ETH prices here and flatten every suggestion to
// the same number.
const MIN_PRICE_WEI = 100_000_000_000n; // 0.0000001 ETH
const pct = (x: number) => `${Math.round(x * 100)}%`;


/**
 * Recommend a price for an agent from its own receipts. Returns null if the agent
 * doesn't exist. Never mutates — call applyOptimization to commit a suggestion.
 */
export function computeOptimization(agentId: string): Optimization | null {
  const agent = getAgentById(agentId);
  if (!agent) return null;

  const history = getTasksByAgent({ agentId, role: "recipient", limit: 500 });
  const completed = history.filter((t) => t.status === "completed").length;
  const failed = history.filter((t) => t.status === "failed").length;
  const terminal = completed + failed;
  const successRate = terminal > 0 ? completed / terminal : 0;
  const load = history.filter((t) => t.status === "running" || t.status === "queued").length;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentVolume = history.filter((t) => t.createdAt >= weekAgo).length;

  const metrics: OptimizationMetrics = {
    completed,
    failed,
    successRate: Math.round(successRate * 1000) / 1000,
    recentVolume,
    load,
  };

  const parsed = agent.price ? parsePaymentAmount(agent.price) : null;
  // Wei throughout: the arithmetic below multiplies and divides a price, and doing that to a float
  // is how a "raise" comes back as the same number it started at.
  const cur = parsed?.wei ?? null;

  const proven = terminal >= 5 && successRate >= 0.9;
  const weak = terminal >= 5 && successRate < 0.6;
  const highDemand = recentVolume >= 10 || load >= 2;
  const idle = recentVolume === 0 && terminal >= 3;

  let action: Optimization["action"] = "hold";
  let suggested: bigint | null = cur;
  let rationale: string;

  if (cur !== null) {
    if (proven && highDemand) {
      action = "raise";
      const byFactor = (cur * 12n) / 10n;
      const byStep = cur + MIN_PRICE_WEI;
      suggested = byFactor > byStep ? byFactor : byStep;
      rationale = `${completed} completed at ${pct(successRate)} success with strong recent demand, room to raise.`;
    } else if (weak) {
      action = "lower";
      const lowered = (cur * 8n) / 10n;
      suggested = lowered > MIN_PRICE_WEI ? lowered : MIN_PRICE_WEI;
      rationale = `Success rate ${pct(successRate)} over ${terminal} tasks is low, lower the price to win work back.`;
    } else if (idle && cur > MIN_PRICE_WEI) {
      action = "lower";
      const lowered = (cur * 8n) / 10n;
      suggested = lowered > MIN_PRICE_WEI ? lowered : MIN_PRICE_WEI;
      rationale = `No hires in the last 7 days, lower the price to attract demand.`;
    } else {
      rationale = terminal > 0
        ? `Steady: ${completed} completed at ${pct(successRate)} success, hold.`
        : `No track record yet, hold.`;
    }
    // No-op guard: if the suggestion doesn't actually move the price (e.g. already
    // at the floor), report it as a hold rather than "applying" an unchanged price.
    if (action !== "hold" && suggested !== null && suggested === cur) {
      action = "hold";
      rationale = `Already at the right price for its track record, hold.`;
    }
  } else if (!agent.price) {
    // free lane
    if (proven && highDemand) {
      action = "raise";
      suggested = 50_000_000_000_000n; // 0.00005 ETH, a first price rather than a guess at value
      rationale = `Proven (${completed} completed at ${pct(successRate)}) and in demand while free, could start charging.`;
    } else {
      rationale = `Free lane, build a track record before pricing.`;
    }
  } else {
    rationale = `Priced in something this chain does not settle, no suggestion.`;
  }

  const suggestedPrice = action === "hold"
    ? agent.price ?? null
    : suggested !== null ? formatEth(suggested) : agent.price ?? null;

  return { agentId, currentPrice: agent.price ?? null, suggestedPrice, action, rationale, metrics };
}

/** Commit a suggested price to the agent. */
export function applyOptimization(agentId: string, price: string | null): void {
  updateAgent(agentId, { price });
}
