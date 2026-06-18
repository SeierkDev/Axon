-- Indexes to support efficient age-based bulk deletion during retention cleanup.
-- Note: idx_spend_alerts_fired_at already exists from 016_spend_thresholds.sql.
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at        ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at  ON webhook_deliveries(created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at           ON rate_limit_windows(reset_at);
CREATE INDEX IF NOT EXISTS idx_agent_metrics_window_start     ON agent_metrics(window_start);
