// Phase 11 — subcontracting. Links a child hire back to the parent task it was
// spawned from, so the parent's receipt shows the full chain of who did the work.

import { getDb } from "./db";
import { syncToTurso } from "./db-turso";

export interface Subcontract {
  childTaskId: string;
  parentTaskId: string;
  fromAgent: string;
  toAgent: string;
  price: string | null;
  createdAt: string;
}

interface SubcontractRow {
  child_task_id: string;
  parent_task_id: string;
  from_agent: string;
  to_agent: string;
  price: string | null;
  created_at: string;
}

function rowTo(r: SubcontractRow): Subcontract {
  return {
    childTaskId: r.child_task_id,
    parentTaskId: r.parent_task_id,
    fromAgent: r.from_agent,
    toAgent: r.to_agent,
    price: r.price,
    createdAt: r.created_at,
  };
}

export function recordSubcontract(opts: {
  parentTaskId: string;
  childTaskId: string;
  fromAgent: string;
  toAgent: string;
  price?: string | null;
}): Subcontract {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO task_subcontracts
       (child_task_id, parent_task_id, from_agent, to_agent, price, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.childTaskId, opts.parentTaskId, opts.fromAgent, opts.toAgent, opts.price ?? null, now);
  void syncToTurso();
  return {
    childTaskId: opts.childTaskId,
    parentTaskId: opts.parentTaskId,
    fromAgent: opts.fromAgent,
    toAgent: opts.toAgent,
    price: opts.price ?? null,
    createdAt: now,
  };
}

/** The subcontracts a parent task spawned (the sub-agents it hired). */
export function getSubcontractsForParent(parentTaskId: string): Subcontract[] {
  const rows = getDb()
    .prepare("SELECT * FROM task_subcontracts WHERE parent_task_id = ? ORDER BY created_at ASC")
    .all(parentTaskId) as SubcontractRow[];
  return rows.map(rowTo);
}

/** The parent task a child hire was subcontracted from, or null. */
export function getSubcontractParent(childTaskId: string): Subcontract | null {
  const row = getDb()
    .prepare("SELECT * FROM task_subcontracts WHERE child_task_id = ?")
    .get(childTaskId) as SubcontractRow | undefined;
  return row ? rowTo(row) : null;
}
