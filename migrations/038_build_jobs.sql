-- Durable Axon Build job queue. Build progress used to live only in process
-- memory, so any restart (deploy, crash) mid-build lost the job and forced the
-- customer to click Resume. Jobs now persist here and unfinished ones are
-- auto-resumed on server boot.

CREATE TABLE IF NOT EXISTS build_jobs (
  build_id    TEXT PRIMARY KEY,
  signature   TEXT NOT NULL DEFAULT '',
  prompt      TEXT NOT NULL DEFAULT '',
  steps       TEXT NOT NULL DEFAULT '{}',
  html        TEXT,
  passed      INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  updated_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_build_jobs_signature ON build_jobs (signature);
CREATE INDEX IF NOT EXISTS idx_build_jobs_done_updated ON build_jobs (done, updated_at);
