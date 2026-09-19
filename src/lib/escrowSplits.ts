// Phase 8: multi-agent escrow splits.
//
// A paid task's escrow can be divided among several agents by share (basis
// points summing to 10000). The payer defines the split before the task
// settles; releasePayment() in payments.ts distributes the escrowed amount to
// each recipient per their share on completion, instead of paying one agent.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { getAgentById } from "./agents";
import { logger } from "./logger";

export const TOTAL_BPS = 10_000;

export interface SplitRecipient {
  agentId: string;
  shareBps: number;
}

export interface TaskSplit extends SplitRecipient {
  splitId: string;
  taskId: string;
  createdAt: string;
}

interface SplitRow {
  split_id: string;
  task_id: string;
  agent_id: string;
  share_bps: number;
  created_at: string;
}

function rowToSplit(row: SplitRow): TaskSplit {
  return {
    splitId: row.split_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    shareBps: row.share_bps,
    createdAt: row.created_at,
  };
}

export type SplitErrorCode = "INVALID" | "NOT_FOUND";
export type DefineSplitsResult =
  | { success: true; splits: TaskSplit[] }
  | { success: false; error: string; code: SplitErrorCode };

export function getSplitsForTask(taskId: string): TaskSplit[] {
  const rows = getDb()
    .prepare("SELECT * FROM task_splits WHERE task_id = ? ORDER BY created_at ASC, share_bps DESC")
    .all(taskId) as SplitRow[];
  return rows.map(rowToSplit);
}

// Define (or replace) the escrow split for a task. Validates that every share is
// a positive basis-point value, agents are distinct and exist, and the shares
// sum to exactly 100% (10000 bps).
export function defineSplits(taskId: string, recipients: SplitRecipient[]): DefineSplitsResult {
  if (recipients.length < 2) {
    return { success: false, error: "A split needs at least two recipients", code: "INVALID" };
  }

  const seen = new Set<string>();
  let total = 0;
  for (const r of recipients) {
    if (!Number.isInteger(r.shareBps) || r.shareBps <= 0 || r.shareBps > TOTAL_BPS) {
      return { success: false, error: "Each share must be an integer between 1 and 10000 basis points", code: "INVALID" };
    }
    if (seen.has(r.agentId)) {
      return { success: false, error: `Duplicate recipient '${r.agentId}'`, code: "INVALID" };
    }
    if (!getAgentById(r.agentId)) {
      return { success: false, error: `Agent '${r.agentId}' not found`, code: "NOT_FOUND" };
    }
    seen.add(r.agentId);
    total += r.shareBps;
  }
  if (total !== TOTAL_BPS) {
    return { success: false, error: `Shares must sum to 10000 basis points (got ${total})`, code: "INVALID" };
  }

  const db = getDb();
  const createdAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare("DELETE FROM task_splits WHERE task_id = ?").run(taskId);
    const insert = db.prepare(
      "INSERT INTO task_splits (split_id, task_id, agent_id, share_bps, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const r of recipients) {
      insert.run(randomUUID(), taskId, r.agentId, r.shareBps, createdAt);
    }
  })();
  void syncToTurso();
  logger.info("task_split.defined", "Escrow split defined", { taskId, recipients: recipients.length });
  return { success: true, splits: getSplitsForTask(taskId) };
}

// Divide a settled amount across recipients by share. Works in integer
// micro-units (ETH has 6 decimals) and gives any rounding remainder to the
// first recipient, so the parts sum back to exactly the total — no dust lost.
/**
 * Divide an escrow among its recipients, exactly.
 *
 * In wei, with BigInt, because this is the function that decides who gets what. Every share is
 * rounded DOWN, which always leaves a remainder of a few wei rather than distributing more than was
 * escrowed, and that remainder goes to the first recipient. The payouts therefore sum to the escrow
 * exactly: not approximately, and never over.
 *
 * The caller works in wei too. Taking a decimal here and multiplying would reintroduce the float
 * error this is written to avoid.
 */
export function computeSplitAmounts(
  totalWei: bigint,
  splits: Pick<TaskSplit, "agentId" | "shareBps">[]
): { agentId: string; wei: bigint }[] {
  const parts = splits.map((s) => ({
    agentId: s.agentId,
    wei: (totalWei * BigInt(s.shareBps)) / BigInt(TOTAL_BPS),
  }));
  const distributed = parts.reduce((sum, p) => sum + p.wei, 0n);
  if (parts.length > 0) parts[0].wei += totalWei - distributed;
  return parts;
}
