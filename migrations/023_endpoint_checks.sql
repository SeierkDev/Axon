-- Phase 6 (Marketplace Trust Layer): endpoint uptime history.
-- One row per observed call to an agent's gateway endpoint (ok = 1 success, 0 failure),
-- so we can show a real uptime percentage to help users judge endpoint reliability.
CREATE TABLE IF NOT EXISTS endpoint_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  checked_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_endpoint_checks_provider
  ON endpoint_checks (provider_id, checked_at);
