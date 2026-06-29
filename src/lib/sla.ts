// Phase 8 (final): agent-to-agent SLAs with automatic penalties.
//
// A task may carry a service-level agreement — a completion deadline and a
// penalty (basis points of the escrowed payment) the provider forfeits to the
// client if the deadline is breached. The client (the task's from_agent / payer)
// sets the terms, mirroring how escrow splits are defined by the payer.
//
// Enforcement is automatic and lives in two places:
//   * resolveSlaOnCompletion / settleCompletedTask — when the provider DOES
//     deliver but late, the payout is docked by penaltyBps at settlement;
//   * enforceSlaDeadlines — a periodic sweep that, when the deadline passes
//     while the task is still queued/running, fails the task and refunds the
//     client in full (the provider delivered nothing).
//
// Reputation penalties come for free from the existing signals: a late
// completion lowers the latency score, and a swept-to-failed task lowers the
// success rate and payment reliability.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { getTaskById, failTask } from "./tasks";
import { releasePayment, releaseWithPenalty, refundPayment, type Payment } from "./payments";
import { logger } from "./logger";

export const MAX_PENALTY_BPS = 10_000;

export type SlaStatus = "active" | "met" | "breached";

export interface TaskSla {
  slaId: string;
  taskId: string;
  deadlineAt: string;
  penaltyBps: number;
  status: SlaStatus;
  resolvedAt?: string;
  createdAt: string;
}

interface SlaRow {
  sla_id: string;
  task_id: string;
  deadline_at: string;
  penalty_bps: number;
  status: SlaStatus;
  resolved_at: string | null;
  created_at: string;
}

function rowToSla(row: SlaRow): TaskSla {
  return {
    slaId: row.sla_id,
    taskId: row.task_id,
    deadlineAt: row.deadline_at,
    penaltyBps: row.penalty_bps,
    status: row.status,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
  };
}

export function getSlaForTask(taskId: string): TaskSla | null {
  const row = getDb().prepare("SELECT * FROM task_slas WHERE task_id = ?").get(taskId) as SlaRow | undefined;
  return row ? rowToSla(row) : null;
}

export type SlaErrorCode = "INVALID" | "NOT_FOUND";
export type DefineSlaResult =
  | { success: true; sla: TaskSla }
  | { success: false; error: string; code: SlaErrorCode };

// Define (or replace) the SLA on a task. Terms must be set BEFORE work begins:
// once the task is running (or settled) they are locked, so a client can't grief
// the provider by shortening the deadline mid-flight to force a breach and claw
// back the earned fee. The deadline and penalty are public, so a provider sees
// the terms before committing.
export function defineSla(taskId: string, deadlineSeconds: number, penaltyBps: number): DefineSlaResult {
  const task = getTaskById(taskId);
  if (!task) return { success: false, error: `Task '${taskId}' not found`, code: "NOT_FOUND" };
  if (task.status !== "queued" && task.status !== "payment_pending") {
    return {
      success: false,
      error: "An SLA can only be set before the task starts running",
      code: "INVALID",
    };
  }
  if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0) {
    return { success: false, error: "deadlineSeconds must be a positive number", code: "INVALID" };
  }
  if (!Number.isInteger(penaltyBps) || penaltyBps < 1 || penaltyBps > MAX_PENALTY_BPS) {
    return { success: false, error: "penaltyBps must be an integer between 1 and 10000", code: "INVALID" };
  }

  const db = getDb();
  const slaId = randomUUID();
  const createdAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + Math.round(deadlineSeconds * 1000)).toISOString();
  db.transaction(() => {
    db.prepare("DELETE FROM task_slas WHERE task_id = ?").run(taskId);
    db.prepare(
      "INSERT INTO task_slas (sla_id, task_id, deadline_at, penalty_bps, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
    ).run(slaId, taskId, deadlineAt, penaltyBps, createdAt);
  })();
  void syncToTurso();
  logger.info("task_sla.defined", "Task SLA defined", { taskId, deadlineAt, penaltyBps });
  return { success: true, sla: getSlaForTask(taskId)! };
}

// Resolve an active SLA at completion time: mark it met or breached and report
// the breach decision. Returns null when the task has no active SLA.
export function resolveSlaOnCompletion(
  taskId: string,
  completedAt: string
): { breached: boolean; penaltyBps: number } | null {
  const sla = getSlaForTask(taskId);
  if (!sla || sla.status !== "active") return null;

  const breached = completedAt > sla.deadlineAt;
  getDb()
    .prepare("UPDATE task_slas SET status=?, resolved_at=? WHERE task_id=?")
    .run(breached ? "breached" : "met", completedAt, taskId);
  void syncToTurso();

  if (breached) {
    logger.warn("task_sla.breached", "SLA breached on late completion", {
      taskId,
      deadlineAt: sla.deadlineAt,
      completedAt,
      penaltyBps: sla.penaltyBps,
    });
  }
  return { breached, penaltyBps: sla.penaltyBps };
}

// Settle a just-completed task's payment, applying the SLA penalty if the
// deadline was breached. Used by every completion path (complete route, stream,
// gateway, worker) so the penalty behaves identically everywhere. With no SLA it
// is exactly a plain releasePayment.
export function settleCompletedTask(taskId: string): Payment | null {
  const task = getTaskById(taskId);
  const completedAt = task?.completedAt ?? new Date().toISOString();
  const resolution = resolveSlaOnCompletion(taskId, completedAt);
  if (resolution?.breached && resolution.penaltyBps > 0) {
    return releaseWithPenalty(taskId, resolution.penaltyBps);
  }
  return releasePayment(taskId);
}

// Sweep: a task whose SLA deadline passed while still queued/running means the
// provider never delivered — fail it and refund the client in full. failTask is
// the gate, so if the task settled in the meantime (race with the completion
// path) the SLA is left to that path. Intended to run on a periodic cron.
export function enforceSlaDeadlines(now: string = new Date().toISOString()): { breached: string[] } {
  const db = getDb();
  const due = db
    .prepare(
      `SELECT s.task_id AS taskId
         FROM task_slas s
         JOIN tasks t ON t.task_id = s.task_id
        WHERE s.status = 'active' AND s.deadline_at < ? AND t.status IN ('queued','running','payment_pending')`
    )
    .all(now) as { taskId: string }[];

  const breached: string[] = [];
  for (const { taskId } of due) {
    try {
      if (failTask(taskId, "SLA deadline exceeded — task not delivered in time")) {
        db.prepare("UPDATE task_slas SET status='breached', resolved_at=? WHERE task_id=?").run(now, taskId);
        refundPayment(taskId);
        breached.push(taskId);
      }
    } catch (err) {
      logger.error("task_sla.sweep_failed", "Failed to enforce SLA deadline", { err, taskId });
    }
  }
  if (breached.length > 0) {
    logger.warn("task_sla.swept", "Auto-failed tasks past their SLA deadline", { count: breached.length });
    void syncToTurso();
  }
  return { breached };
}
