CREATE TABLE IF NOT EXISTS spend_thresholds (
  threshold_id   TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL UNIQUE,
  threshold_usdc REAL NOT NULL,
  window_hours   INTEGER NOT NULL DEFAULT 24,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spend_alerts (
  alert_id       TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  threshold_id   TEXT NOT NULL,
  amount_usdc    REAL NOT NULL,
  threshold_usdc REAL NOT NULL,
  window_hours   INTEGER NOT NULL,
  fired_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spend_thresholds_agent ON spend_thresholds(agent_id);
CREATE INDEX IF NOT EXISTS idx_spend_alerts_agent     ON spend_alerts(agent_id);
CREATE INDEX IF NOT EXISTS idx_spend_alerts_fired_at  ON spend_alerts(fired_at DESC);
