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
  | "plan" | "search" | "hire" | "payment" | "review" | "result" | "self" | "synthesis" | "note" | "error";

export interface GrowRun {
  runId: string;
  agentId: string;
  /** Whose mission this is. Null on the original platform experiment runs. */
  ownerWallet?: string;
  mission: string;
  budgetUsdc: number;
  perHireCapUsdc?: number;
  maxHires?: number;
  status: GrowStatus;
  /** The owner called it off; the runner stops at the next safe point. */
  canceled?: boolean;
  plan?: unknown;
  deliverable?: string;
  /** The mission receipt, once the run is finished. See ./growReceipt. */
  manifest?: unknown;
  /** The owner chose to put this on a public page. Opt-in, and reversible. */
  published?: boolean;
  publishedAt?: string;
  /** Which template it started from, if any. */
  templateId?: string;
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
  run_id: string; agent_id: string; owner_wallet: string | null; mission: string;
  budget_usdc: number; per_hire_cap_usdc: number | null; max_hires: number | null;
  status: string; canceled: number; plan: string | null; deliverable: string | null; manifest: string | null;
  published: number; published_at: string | null; template_id: string | null;
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
    runId: r.run_id, agentId: r.agent_id, ownerWallet: r.owner_wallet ?? undefined,
    mission: r.mission, budgetUsdc: r.budget_usdc,
    perHireCapUsdc: r.per_hire_cap_usdc ?? undefined, maxHires: r.max_hires ?? undefined,
    status: r.status as GrowStatus, canceled: r.canceled === 1, plan: parseJson(r.plan),
    deliverable: r.deliverable ?? undefined, manifest: parseJson(r.manifest),
    published: r.published === 1, publishedAt: r.published_at ?? undefined,
    templateId: r.template_id ?? undefined,
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

export function createGrowRun(opts: {
  agentId: string; mission: string; budgetUsdc: number;
  ownerWallet?: string; perHireCapUsdc?: number; maxHires?: number; templateId?: string;
}): GrowRun {
  const db = getDb();
  const runId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO grow_runs
      (run_id, agent_id, owner_wallet, mission, budget_usdc, per_hire_cap_usdc, max_hires, template_id,
       status, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)
  `).run(
    runId, opts.agentId, opts.ownerWallet ?? null, opts.mission, opts.budgetUsdc,
    opts.perHireCapUsdc ?? null, opts.maxHires ?? null, opts.templateId ?? null, now, now,
  );
  void syncToTurso();
  return rowToRun(db.prepare("SELECT * FROM grow_runs WHERE run_id = ?").get(runId) as GrowRunRow);
}

/** Missions belonging to one owner, newest first. */
export function listGrowRunsForOwner(ownerWallet: string, limit = 20): GrowRun[] {
  return (getDb().prepare(
    "SELECT * FROM grow_runs WHERE owner_wallet = ? ORDER BY started_at DESC LIMIT ?",
  ).all(ownerWallet, limit) as GrowRunRow[]).map(rowToRun);
}

/**
 * Call a mission off. Cooperative rather than a hard kill: the runner checks
 * between steps, so a stop can never land in the middle of a payment and leave
 * money moved with nothing recorded. Only the owner can do it, and only while
 * the run is still going.
 */
export function cancelGrowRun(runId: string, ownerWallet: string): GrowRun | null {
  const db = getDb();
  const changed = db.prepare(
    `UPDATE grow_runs SET canceled = 1, updated_at = ?
     WHERE run_id = ? AND owner_wallet = ? AND status NOT IN ('completed','failed')`,
  ).run(new Date().toISOString(), runId, ownerWallet).changes;
  void syncToTurso();
  if (!changed) return null;
  return getGrowRun(runId);
}

/** Has the owner called this run off? Read fresh — the runner polls it. */
export function isGrowRunCanceled(runId: string): boolean {
  const row = getDb().prepare("SELECT canceled FROM grow_runs WHERE run_id = ?").get(runId) as
    | { canceled: number } | undefined;
  return row?.canceled === 1;
}

export function updateGrowRun(
  runId: string,
  patch: Partial<Pick<GrowRun, "status" | "plan" | "deliverable" | "manifest">>,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const done = patch.status === "completed" || patch.status === "failed";
  db.prepare(`
    UPDATE grow_runs SET
      status       = COALESCE(?, status),
      plan         = COALESCE(?, plan),
      deliverable  = COALESCE(?, deliverable),
      manifest     = COALESCE(?, manifest),
      updated_at   = ?,
      completed_at = CASE WHEN ? THEN ? ELSE completed_at END
    WHERE run_id = ?
  `).run(
    patch.status ?? null,
    patch.plan !== undefined ? JSON.stringify(patch.plan) : null,
    patch.deliverable ?? null,
    patch.manifest !== undefined ? JSON.stringify(patch.manifest) : null,
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

/**
 * Put a finished mission on a public page, or take it back down.
 *
 * Only the owner, and only a run that has finished — publishing something still
 * in flight would show a half-built result that then changes under whoever is
 * reading it.
 *
 * This is the one place in Missions that makes CONTENT public. The receipt is
 * content-free by design; a published mission shows the brief and the result in
 * full, so it stays off by default and comes back down the moment it's asked to.
 */
export function setGrowRunPublished(
  runId: string,
  ownerWallet: string,
  published: boolean,
): GrowRun | null {
  const db = getDb();
  const now = new Date().toISOString();
  const changed = db.prepare(
    `UPDATE grow_runs SET published = ?, published_at = ?, updated_at = ?
     WHERE run_id = ? AND owner_wallet = ? AND status IN ('completed','failed')`,
  ).run(published ? 1 : 0, published ? now : null, now, runId, ownerWallet).changes;
  void syncToTurso();
  return changed ? getGrowRun(runId) : null;
}

/** A published mission, by id. Null for anything not published — the same answer
 *  as a run that doesn't exist, so an unpublished id can't be probed for. */
export function getPublishedGrowRun(runId: string): GrowRun | null {
  const row = getDb().prepare(
    "SELECT * FROM grow_runs WHERE run_id = ? AND published = 1",
  ).get(runId) as GrowRunRow | undefined;
  return row ? rowToRun(row) : null;
}

/**
 * The gallery: recently published missions, newest first, at most `perOwner`
 * from any one owner.
 *
 * The cap is the whole point. Plain "newest first" means one person publishing
 * a handful of missions occupies every slot — measured, seven publishes from one
 * owner filled a six-card strip and pushed everyone else out. That is the likely
 * case rather than the adversarial one: whoever tries Missions first will have
 * several runs before anyone else has one, and the gallery would then show only
 * their work under a heading promising other people's.
 *
 * Ownerless rows are the platform's own early experiment runs; they partition by
 * run id so each stays its own entry instead of collapsing into a single slot.
 *
 * `published_at` alone does not order this. It has millisecond resolution, and
 * seven consecutive publishes measured only two distinct values — so ties are
 * the norm in any burst, not a corner case. SQLite's natural order among ties is
 * rowid ascending, which hands the "newest" slot to the oldest row. rowid DESC
 * breaks the tie the way the timestamp intended.
 */
export function listPublishedGrowRuns(limit = 12, perOwner = 2): GrowRun[] {
  return (getDb().prepare(`
    SELECT * FROM (
      SELECT *, rowid AS rid, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(owner_wallet, run_id) ORDER BY published_at DESC, rowid DESC
      ) AS rn
      FROM grow_runs WHERE published = 1
    ) WHERE rn <= ? ORDER BY published_at DESC, rid DESC LIMIT ?
  `).all(perOwner, limit) as GrowRunRow[]).map(rowToRun);
}

/** How much of the budget has been committed to hires so far (sum of payment events). */
export function getGrowSpent(runId: string): number {
  const { spent } = getDb().prepare(
    "SELECT COALESCE(SUM(amount_usdc), 0) AS spent FROM grow_events WHERE run_id = ? AND kind = 'payment'",
  ).get(runId) as { spent: number };
  return Math.round(spent * 10000) / 10000;
}
