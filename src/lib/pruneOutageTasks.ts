// Remove the tasks that failed because the platform's own provider key was invalid.
//
// Between 2026-09-17 and 2026-09-19 the Anthropic key configured for the platform was rejected on
// every call. The generated-activity cron kept producing its usual few hundred tasks a day and
// every one of them failed on that same error, so one misconfiguration was written into the
// ledger several thousand times over.
//
// What that leaves behind is not a record of agents failing. It is the platform's own synthetic
// activity recording the platform's own broken credential, and because it is counted in every
// all-time figure it describes one bad afternoon forever: an error rate beside each agent that no
// amount of later work can bring down.
//
// This is deliberately narrow, and it is the narrowness that makes it defensible:
//   - only tasks whose stored error is that specific authentication failure
//   - only tasks with no payment attached, so nothing that touched money is ever removed
//   - only tasks that failed, never a completed one
// Anything a person actually submitted and watched fail for any other reason stays exactly where
// it is, and so does every real failure of a real agent.

import type { Database } from "better-sqlite3";

/** The provider's wording when the key itself is rejected. Nothing else matches this. */
const OUTAGE_ERROR = "%API key is invalid%";

/** Tables that carry a task_id and should not be left pointing at a task that no longer exists. */
const CHILD_TABLES = [
  "task_progress", "payment_notes", "open_tasks", "bids", "task_splits", "task_slas",
  "trace_events", "reproducibility_proofs", "task_subcontracts", "purchase_intents",
  "mpp_debits", "grow_events",
] as const;

export interface PruneReport {
  applied: boolean;
  tasksTotal: number;
  failedTotal: number;
  inScope: number;
  failedAfter: number;
  firstAt: string | null;
  lastAt: string | null;
  sample: { taskId: string; from: string; to: string; at: string }[];
  removedTasks: number;
  removedRelated: number;
}

const SCOPE = `
  FROM tasks t
  WHERE t.status = 'failed'
    AND t.error LIKE ?
    AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.task_id = t.task_id)
`;

export function pruneOutageTasks(db: Database, opts: { apply: boolean }): PruneReport {
  const { n } = db.prepare(`SELECT COUNT(*) AS n ${SCOPE}`).get(OUTAGE_ERROR) as { n: number };
  const span = db
    .prepare(`SELECT MIN(t.completed_at) AS first, MAX(t.completed_at) AS last ${SCOPE}`)
    .get(OUTAGE_ERROR) as { first: string | null; last: string | null };
  const totals = db
    .prepare("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='failed') AS failed FROM tasks")
    .get() as { total: number; failed: number };
  const sample = (db
    .prepare(`SELECT t.task_id, t.from_agent, t.to_agent, t.completed_at ${SCOPE} LIMIT 5`)
    .all(OUTAGE_ERROR) as { task_id: string; from_agent: string; to_agent: string; completed_at: string }[])
    .map((s) => ({ taskId: s.task_id, from: s.from_agent, to: s.to_agent, at: s.completed_at }));

  const report: PruneReport = {
    applied: false,
    tasksTotal: totals.total,
    failedTotal: totals.failed,
    inScope: n,
    failedAfter: totals.failed - n,
    firstAt: span.first,
    lastAt: span.last,
    sample,
    removedTasks: 0,
    removedRelated: 0,
  };
  if (n === 0 || !opts.apply) return report;

  const ids = (db.prepare(`SELECT t.task_id ${SCOPE}`).all(OUTAGE_ERROR) as { task_id: string }[])
    .map((r) => r.task_id);

  let removedRelated = 0;
  // One transaction: either the tasks and everything hanging off them go, or nothing does.
  db.transaction(() => {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const qs = chunk.map(() => "?").join(",");
      for (const table of CHILD_TABLES) {
        try {
          removedRelated += db.prepare(`DELETE FROM ${table} WHERE task_id IN (${qs})`).run(...chunk).changes;
        } catch {
          // A table this database does not have yet is not worth stopping for.
        }
      }
      db.prepare(`DELETE FROM tasks WHERE task_id IN (${qs})`).run(...chunk);
    }
    // The error_log rows describing the same incident go too, otherwise the admin view still
    // reports thousands of failures for tasks that are no longer there to look at.
    db.prepare("DELETE FROM error_log WHERE event = 'task.failed' AND details LIKE ?").run(OUTAGE_ERROR);
  })();

  const after = db.prepare("SELECT COUNT(*) AS failed FROM tasks WHERE status='failed'").get() as { failed: number };
  return { ...report, applied: true, removedTasks: ids.length, removedRelated, failedAfter: after.failed };
}
