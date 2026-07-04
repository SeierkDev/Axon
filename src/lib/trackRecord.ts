import { getDb } from "./db";
import { computeReputation } from "./reputation";
import { getAttestationsForAgent } from "./attestations";
import { getAgentById, isContractTestAgent } from "./agents";
import { isOwnerVerified } from "./ownerVerification";

// Agent Track Records — a proof-backed public profile.
//
// This module NEVER computes a stat a different surface already owns; it
// composes the exact same functions the Explorer, reputation system and world
// use, so the numbers can't drift (an Explorer count of 268 is a track-record
// count of 268, by construction). The only piece it adds is USDC-earned, using
// the identical settlement query the world snapshot runs. Same privacy rule as
// receipts: parties, counts, timestamps, terms — never task content.

export interface TrackRecordJob {
  taskId: string; // links to its public /r/<taskId> receipt
  counterparty: string; // requester's display name
  payment: string | null;
  completedAt: string;
}

export interface AgentTrackRecord {
  agentId: string;
  name: string;
  category: string;
  verified: boolean;
  ownerVerified: boolean;
  price: string | null;
  // Stats — every one from an existing shared function.
  reputation: number;
  tasksCompleted: number;
  tasksFailed: number;
  successRate: number; // 0..1
  avgResponseSec: number;
  paymentReliability: number; // 0..1
  usdcEarned: number;
  // Live status, same source as the world house terminal.
  running: number;
  queued: number;
  lastCompletedAt: string | null;
  // Trust surface.
  attestations: { capability: string; verifier: string; createdAt: string }[];
  // Recent verified work — each links to its public receipt.
  recentJobs: TrackRecordJob[];
}

// Live status — running/queued/last-completed. Self-contained (no dependency
// on the world module) so track records publish independently; identical query
// to the world house terminal's getAgentActivity.
function liveStatus(agentId: string): { running: number; queued: number; lastCompletedAt: string | null } {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'running') AS running,
         COUNT(*) FILTER (WHERE status = 'queued')  AS queued,
         MAX(completed_at) FILTER (WHERE status = 'completed') AS last_completed_at
       FROM tasks WHERE to_agent = ?`,
    )
    .get(agentId) as { running: number; queued: number; last_completed_at: string | null } | undefined;
  return {
    running: row?.running ?? 0,
    queued: row?.queued ?? 0,
    lastCompletedAt: row?.last_completed_at ?? null,
  };
}

// The SAME settlement sum the world snapshot uses (completed USDC only).
function usdcEarned(agentId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_sol), 0) AS usdc
       FROM transactions
       WHERE to_agent = ? AND status = 'completed' AND currency = 'USDC'`,
    )
    .get(agentId) as { usdc: number };
  return Math.round(row.usdc * 1_000_000) / 1_000_000;
}

// Friendly labels for the network's system requesters — a raw
// "axon-world-visitor" id on a public profile reads like a bug.
const SYSTEM_COUNTERPARTY: Record<string, string> = {
  "axon-world-visitor": "a World visitor",
  "axon-network": "the Axon network",
};

function recentJobs(agentId: string): TrackRecordJob[] {
  // Over-fetch so filtering contract-test rows still leaves a full list.
  // The displayed amount is what the agent ACTUALLY settled for the job (the
  // same transactions usdcEarned sums) — the task.payment field is often null
  // on seed/demo jobs even though they settled, which showed a paid job as
  // "free". Fall back to task.payment (agreed terms) only if nothing settled.
  const rows = getDb()
    .prepare(
      `SELECT t.task_id, t.from_agent, t.payment, t.completed_at,
              COALESCE(a.name, t.from_agent) AS counterparty,
              (SELECT x.amount_sol FROM transactions x
                 WHERE x.task_id = t.task_id AND x.to_agent = t.to_agent
                   AND x.status = 'completed' AND x.currency = 'USDC'
                 LIMIT 1) AS settled_usdc
       FROM tasks t LEFT JOIN agents a ON a.agent_id = t.from_agent
       WHERE t.to_agent = ? AND t.status = 'completed'
       ORDER BY t.completed_at DESC LIMIT 40`,
    )
    .all(agentId) as {
      task_id: string;
      from_agent: string;
      payment: string | null;
      completed_at: string;
      counterparty: string;
      settled_usdc: number | null;
    }[];
  return rows
    // Contract-test jobs are automated checks, not real work — the whole
    // network hides them; a public profile must too.
    .filter((r) => !isContractTestAgent(r.from_agent))
    .slice(0, 12)
    .map((r) => ({
      taskId: r.task_id,
      counterparty: SYSTEM_COUNTERPARTY[r.from_agent] ?? r.counterparty,
      // 2-decimal USDC to match listed-price formatting ("0.10", not "0.1").
      payment: r.settled_usdc != null ? `${r.settled_usdc.toFixed(2)} USDC` : r.payment,
      completedAt: r.completed_at,
    }));
}

export function getAgentTrackRecord(agentId: string): AgentTrackRecord | null {
  const agent = getAgentById(agentId);
  if (!agent) return null;

  const rep = computeReputation(agentId); // same fn the profile + trust badge use
  const act = liveStatus(agentId); // running/queued/last-completed

  return {
    agentId: agent.agentId,
    name: agent.name,
    category: agent.category ?? "General",
    verified: agent.verificationStatus === "platform" || agent.verificationStatus === "x402_compliant",
    ownerVerified: isOwnerVerified(agentId),
    price: agent.price ?? null,
    reputation: agent.reputation ?? 0,
    tasksCompleted: rep.totalTasksCompleted,
    tasksFailed: rep.totalTasksFailed,
    successRate: rep.successRate,
    avgResponseSec: rep.avgResponseTimeSec,
    paymentReliability: rep.paymentReliability,
    usdcEarned: usdcEarned(agentId),
    running: act.running,
    queued: act.queued,
    lastCompletedAt: act.lastCompletedAt,
    attestations: getAttestationsForAgent(agentId).map((a) => ({
      capability: a.capability,
      verifier: a.verifier,
      createdAt: a.createdAt,
    })),
    recentJobs: recentJobs(agentId),
  };
}
