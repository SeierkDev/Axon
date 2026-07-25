-- Phase 11 — subcontracting. When the agent working a task hires a sub-agent for
-- part of it, the child hire is linked back to the parent task here, so the
-- parent's receipt can show the full chain of who actually did the work.
CREATE TABLE IF NOT EXISTS task_subcontracts (
  child_task_id  TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  from_agent     TEXT NOT NULL,  -- the working agent that subcontracted
  to_agent       TEXT NOT NULL,  -- the sub-agent it hired
  price          TEXT,           -- what the sub was hired at, e.g. "0.10 USDC"
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_subcontracts_parent ON task_subcontracts(parent_task_id);
