-- Distributed tracing: every task carries a trace_id that links it to the
-- originating HTTP request and all downstream events (payments, webhooks, worker).
ALTER TABLE tasks ADD COLUMN trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_trace_id
  ON tasks(trace_id)
  WHERE trace_id IS NOT NULL;
