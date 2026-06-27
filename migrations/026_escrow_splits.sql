-- Phase 8 (Advanced Protocol Features): multi-agent escrow splits.
-- A paid task's escrow can be divided among several agents by share (basis
-- points summing to 10000). The split is defined by the payer before the task
-- settles; on settlement the escrowed amount is distributed to each recipient
-- per their share instead of paying a single agent.

CREATE TABLE IF NOT EXISTS task_splits (
  split_id    TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  share_bps   INTEGER NOT NULL,   -- basis points (1..10000); a task's rows sum to 10000
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_splits_task ON task_splits (task_id);
-- One split entry per agent per task.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_splits_unique ON task_splits (task_id, agent_id);
