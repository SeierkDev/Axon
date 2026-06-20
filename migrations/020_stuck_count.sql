-- Tracks how many times a worker-running task has been reset as stuck.
-- Used by the dead-letter logic to stop infinite stuck→queued loops.
ALTER TABLE tasks ADD COLUMN stuck_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tasks_stuck ON tasks(status, started_by, started_at) WHERE status = 'running';
