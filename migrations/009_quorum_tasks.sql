-- Quorum tasks: multi-agent consensus execution.
-- A quorum task fans out to N agents; the result is accepted once
-- `threshold` agents complete. The highest-reputation completion wins.

ALTER TABLE tasks ADD COLUMN quorum_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_quorum_id
  ON tasks(quorum_id) WHERE quorum_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quorum_tasks (
  quorum_id      TEXT PRIMARY KEY,
  from_agent     TEXT NOT NULL,
  task_content   TEXT NOT NULL,
  threshold      INTEGER NOT NULL CHECK(threshold >= 1),
  agent_count    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending', 'completed', 'failed')),
  accepted_result TEXT,
  accepted_agent  TEXT,
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);
