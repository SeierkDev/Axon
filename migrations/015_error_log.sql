CREATE TABLE IF NOT EXISTS error_log (
  error_id   TEXT PRIMARY KEY,
  ts         TEXT NOT NULL,
  level      TEXT NOT NULL,
  event      TEXT NOT NULL,
  message    TEXT NOT NULL,
  source     TEXT,
  agent_id   TEXT,
  task_id    TEXT,
  trace_id   TEXT,
  request_id TEXT,
  details    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_log_ts    ON error_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_level ON error_log(level);
CREATE INDEX IF NOT EXISTS idx_error_log_event ON error_log(event);
