import type { Database } from "better-sqlite3";
import { getDb } from "./db";
import { createHash } from "crypto";
import { canonicalStringify } from "./traceEvents";

// Verifiable work — the input-side commitment.
//
// hashSpec pins the exact job agreement (who hired whom, the task rules, context, and payment
// terms) at task creation. It is the counterpart to outputCommitment's deliverable hash: spec_hash
// proves what was agreed, output_hash proves what was delivered.
//
// The digest is SHA-256 over canonical JSON — keys sorted recursively, no whitespace — which is the
// same canonical form the trace hash chain uses, so there is one definition of "canonical" in this
// codebase rather than two that could quietly drift apart.

export interface SpecInput {
  fromAgent: string;
  toAgent: string;
  task: string;
  context?: Record<string, unknown>;
  payment?: string | null;
}

/** The pinned shape. Field order here is irrelevant: the canonical form sorts them. */
function canonicalSpec(spec: SpecInput): string {
  return canonicalStringify({
    from: spec.fromAgent,
    to: spec.toAgent,
    task: spec.task,
    context: spec.context ?? null,
    payment: spec.payment ?? null,
  });
}

export function hashSpec(spec: SpecInput): string {
  return createHash("sha256").update(canonicalSpec(spec), "utf8").digest("hex");
}

// One-time backfill: pin the canonical spec hash for tasks that predate the spec_hash column. The
// hash is a pure function of each task's stored fields, so historical job specs get one too.
// Idempotent — only touches rows where spec_hash IS NULL, so it is a no-op after the first run.
export function backfillSpecHashes(db: Database): number {
  const rows = db
    .prepare("SELECT task_id, from_agent, to_agent, task, context, payment FROM tasks WHERE spec_hash IS NULL")
    .all() as {
    task_id: string;
    from_agent: string;
    to_agent: string;
    task: string;
    context: string | null;
    payment: string | null;
  }[];
  if (rows.length === 0) return 0;

  const update = db.prepare("UPDATE tasks SET spec_hash = ? WHERE task_id = ?");
  const run = db.transaction((items: typeof rows) => {
    for (const r of items) {
      let context: Record<string, unknown> | undefined;
      if (r.context) {
        try {
          context = JSON.parse(r.context) as Record<string, unknown>;
        } catch {
          context = undefined;
        }
      }
      const hash = hashSpec({
        fromAgent: r.from_agent,
        toAgent: r.to_agent,
        task: r.task,
        context,
        payment: r.payment,
      });
      update.run(hash, r.task_id);
    }
  });
  run(rows);
  return rows.length;
}

export interface SpecVerification {
  taskId: string;
  committed: string | null; // hash recorded at creation
  recomputed: string; // hash of the task's current spec fields
  matches: boolean; // false → the agreed rules were altered after the fact
}

// Recompute the spec hash from the task's current fields and compare against the
// hash committed at creation — proves the agreement wasn't altered after work
// started. Returns null if the task doesn't exist.
export function verifyTaskSpec(taskId: string): SpecVerification | null {
  const row = getDb()
    .prepare("SELECT from_agent, to_agent, task, context, payment, spec_hash FROM tasks WHERE task_id = ?")
    .get(taskId) as
    | { from_agent: string; to_agent: string; task: string; context: string | null; payment: string | null; spec_hash: string | null }
    | undefined;
  if (!row) return null;

  let context: Record<string, unknown> | undefined;
  if (row.context) {
    try {
      context = JSON.parse(row.context) as Record<string, unknown>;
    } catch {
      context = undefined;
    }
  }

  const recomputed = hashSpec({
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    task: row.task,
    context,
    payment: row.payment,
  });
  return { taskId, committed: row.spec_hash, recomputed, matches: row.spec_hash === recomputed };
}
