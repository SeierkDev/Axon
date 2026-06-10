-- Worker heartbeat: lets the background worker record its last-seen timestamp
-- so the health endpoint can report whether the worker is alive.

CREATE TABLE IF NOT EXISTS worker_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
