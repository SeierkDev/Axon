-- Verifiable execution traces — the "flight recorder".
--
-- An append-only, hash-chained log of everything that happened for a trace:
-- task creation, each model step, completion/failure, and settlement. Events for
-- one workflow group under a shared trace_id (already carried on tasks.trace_id,
-- migration 014), so a multi-agent pipeline reconstructs as one ordered timeline.
--
-- Each event's `hash` = sha256(canonical(event fields + prev_hash)). Because every
-- event commits to the previous event's hash, altering any past event breaks the
-- chain from that point forward — the trace is tamper-evident without trusting us.
--
-- Privacy rule matches receipts: hashes and small content-free metadata only.
-- NEVER task content or output text — those stay behind the authed API.
CREATE TABLE IF NOT EXISTS trace_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id      TEXT NOT NULL,
  seq           INTEGER NOT NULL,      -- monotonic sequence within a trace_id
  task_id       TEXT,
  kind          TEXT NOT NULL,         -- task.created | step.model | task.completed | task.failed | settlement.completed
  from_agent    TEXT,
  to_agent      TEXT,
  workflow_id   TEXT,
  step_index    INTEGER,
  input_hash    TEXT,                  -- sha256 of the step input / job spec (one-way, privacy-safe)
  output_hash   TEXT,                  -- sha256 of the step output (one-way, privacy-safe)
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,                  -- best-effort estimate from a static price table; null if model unknown
  latency_ms    INTEGER,
  meta          TEXT,                  -- small content-free JSON (e.g. {"amount":0.25,"currency":"USDC"})
  prev_hash     TEXT,                  -- hash of the previous event in this trace (null for the first)
  hash          TEXT NOT NULL,         -- sha256(canonical(this event + prev_hash))
  created_at    TEXT NOT NULL,
  UNIQUE (trace_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_trace_events_trace ON trace_events(trace_id, seq);
CREATE INDEX IF NOT EXISTS idx_trace_events_task ON trace_events(task_id);
