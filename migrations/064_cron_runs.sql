-- A ledger of scheduled job runs.
--
-- The platform watched its database, its worker and its throughput, and watched none of the jobs that
-- keep those things fed. The autonomy pass stopped running on the 20th and nothing noticed for three
-- days, because a cron that fails looks exactly like a cron that has not been scheduled yet: silence.
--
-- One row per run, written by the job itself. Absence of rows is the signal that matters, so the table
-- is read by asking how long it has been since a job last finished rather than by counting failures.

CREATE TABLE IF NOT EXISTS cron_runs (
  id          TEXT PRIMARY KEY,
  job         TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  ms          INTEGER,
  detail      TEXT
);

-- Every read is "the latest run of this job", so the index is built for exactly that.
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started
  ON cron_runs(job, started_at DESC);
