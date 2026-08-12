-- Tier 3: the network pass.
--
-- Two things. An opt-in flag, because tuning somebody's price is their business
-- decision and not ours to make by default — the pass observes every agent and
-- acts only on the ones whose owner asked it to. And a record of each pass, so
-- the network side is as inspectable as the codebase side.

ALTER TABLE agents ADD COLUMN auto_price INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS autonomy_network_runs (
  run_id       TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  -- What the pass saw: capability gaps, dormant listings. JSON array.
  observations TEXT NOT NULL,
  -- What it did, and only ever to agents that opted in. JSON array.
  changes      TEXT NOT NULL,
  agents_seen  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_autonomy_network_started ON autonomy_network_runs(started_at DESC);
