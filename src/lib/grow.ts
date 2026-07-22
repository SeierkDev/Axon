// "Grow yourself" — the durable record of a budgeted autonomous agent's run on
// Axon. The money moves through the normal task/payment paths; this module is the
// narrative ledger: one grow_run per experiment, an append-only grow_events
// timeline (plan → hires → payments → results → synthesis), each hire event
// carrying the taskId so the public page can link straight to its receipt.
import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";

export type GrowStatus = "planning" | "hiring" | "synthesizing" | "completed" | "failed";
export type GrowEventKind =
  | "plan" | "search" | "hire" | "payment" | "result" | "synthesis" | "note" | "error";

export interface GrowRun {
  runId: string;
  agentId: string;
  mission: string;
  budgetUsdc: number;
  status: GrowStatus;
  plan?: unknown;
  deliverable?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface GrowEvent {
  id: number;
  runId: string;
  kind: GrowEventKind;
  summary: string;
  taskId?: string;
  toAgent?: string;
  amountUsdc?: number;
  data?: unknown;
  createdAt: string;
}

interface GrowRunRow {
  run_id: string; agent_id: string; mission: string; budget_usdc: number;
  status: string; plan: string | null; deliverable: string | null;
  started_at: string; updated_at: string; completed_at: string | null;
}
interface GrowEventRow {
  id: number; run_id: string; kind: string; summary: string; task_id: string | null;
  to_agent: string | null; amount_usdc: number | null; data: string | null; created_at: string;
}

function parseJson(s: string | null): unknown {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}
function rowToRun(r: GrowRunRow): GrowRun {
  return {
    runId: r.run_id, agentId: r.agent_id, mission: r.mission, budgetUsdc: r.budget_usdc,
    status: r.status as GrowStatus, plan: parseJson(r.plan),
    deliverable: r.deliverable ?? undefined,
    startedAt: r.started_at, updatedAt: r.updated_at, completedAt: r.completed_at ?? undefined,
  };
}
function rowToEvent(r: GrowEventRow): GrowEvent {
  return {
    id: r.id, runId: r.run_id, kind: r.kind as GrowEventKind, summary: r.summary,
    taskId: r.task_id ?? undefined, toAgent: r.to_agent ?? undefined,
    amountUsdc: r.amount_usdc ?? undefined, data: parseJson(r.data), createdAt: r.created_at,
  };
}

export function createGrowRun(opts: { agentId: string; mission: string; budgetUsdc: number }): GrowRun {
  const db = getDb();
  const runId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO grow_runs (run_id, agent_id, mission, budget_usdc, status, started_at, updated_at)
    VALUES (?, ?, ?, ?, 'planning', ?, ?)
  `).run(runId, opts.agentId, opts.mission, opts.budgetUsdc, now, now);
  void syncToTurso();
  return rowToRun(db.prepare("SELECT * FROM grow_runs WHERE run_id = ?").get(runId) as GrowRunRow);
}

export function updateGrowRun(
  runId: string,
  patch: Partial<Pick<GrowRun, "status" | "plan" | "deliverable">>,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const done = patch.status === "completed" || patch.status === "failed";
  db.prepare(`
    UPDATE grow_runs SET
      status       = COALESCE(?, status),
      plan         = COALESCE(?, plan),
      deliverable  = COALESCE(?, deliverable),
      updated_at   = ?,
      completed_at = CASE WHEN ? THEN ? ELSE completed_at END
    WHERE run_id = ?
  `).run(
    patch.status ?? null,
    patch.plan !== undefined ? JSON.stringify(patch.plan) : null,
    patch.deliverable ?? null,
    now, done ? 1 : 0, now, runId,
  );
  void syncToTurso();
}

export function recordGrowEvent(runId: string, ev: {
  kind: GrowEventKind; summary: string; taskId?: string; toAgent?: string;
  amountUsdc?: number; data?: unknown;
}): GrowEvent {
  const db = getDb();
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO grow_events (run_id, kind, summary, task_id, to_agent, amount_usdc, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, ev.kind, ev.summary, ev.taskId ?? null, ev.toAgent ?? null,
    ev.amountUsdc ?? null, ev.data !== undefined ? JSON.stringify(ev.data) : null, now,
  );
  void syncToTurso();
  return rowToEvent(
    db.prepare("SELECT * FROM grow_events WHERE id = ?").get(info.lastInsertRowid as number) as GrowEventRow,
  );
}

export function getGrowRun(runId: string): GrowRun | null {
  const row = getDb().prepare("SELECT * FROM grow_runs WHERE run_id = ?").get(runId) as GrowRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function getGrowEvents(runId: string): GrowEvent[] {
  return (getDb().prepare("SELECT * FROM grow_events WHERE run_id = ? ORDER BY id ASC").all(runId) as GrowEventRow[])
    .map(rowToEvent);
}

export function listGrowRuns(limit = 20): GrowRun[] {
  return (getDb().prepare("SELECT * FROM grow_runs ORDER BY started_at DESC LIMIT ?").all(limit) as GrowRunRow[])
    .map(rowToRun);
}

export function getLatestGrowRun(): GrowRun | null {
  const row = getDb().prepare("SELECT * FROM grow_runs ORDER BY started_at DESC LIMIT 1").get() as GrowRunRow | undefined;
  return row ? rowToRun(row) : null;
}

/**
 * A non-terminal run for this agent that's still alive — used to block overlaps.
 * "Alive" = it has emitted an event within `staleMs` (else fell over its start).
 * Runs are fire-and-forget, so a process restart can strand a run non-terminal;
 * without the staleness check that orphan would block every future run forever.
 */
export function getActiveGrowRun(agentId: string, staleMs = 15 * 60 * 1000): GrowRun | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM grow_runs WHERE agent_id = ? AND status NOT IN ('completed','failed') ORDER BY started_at DESC LIMIT 1",
  ).get(agentId) as GrowRunRow | undefined;
  if (!row) return null;
  const { t } = db.prepare("SELECT MAX(created_at) AS t FROM grow_events WHERE run_id = ?")
    .get(row.run_id) as { t: string | null };
  const lastActivity = Date.parse(t ?? row.started_at);
  if (Number.isFinite(lastActivity) && Date.now() - lastActivity > staleMs) return null; // orphaned
  return rowToRun(row);
}

/** How much of the budget has been committed to hires so far (sum of payment events). */
export function getGrowSpent(runId: string): number {
  const { spent } = getDb().prepare(
    "SELECT COALESCE(SUM(amount_usdc), 0) AS spent FROM grow_events WHERE run_id = ? AND kind = 'payment'",
  ).get(runId) as { spent: number };
  return Math.round(spent * 10000) / 10000;
}
