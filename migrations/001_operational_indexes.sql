-- Operational indexes for production-like task, payment, webhook, and MPP queries.
-- These are idempotent so existing local databases can adopt the migration safely.

CREATE INDEX IF NOT EXISTS idx_tasks_status_created
  ON tasks(status, created_at);

CREATE INDEX IF NOT EXISTS idx_tasks_to_agent_created
  ON tasks(to_agent, created_at);

CREATE INDEX IF NOT EXISTS idx_transactions_status_created
  ON transactions(status, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
  ON webhook_deliveries(webhook_id, created_at);

CREATE INDEX IF NOT EXISTS idx_mpp_deposits_channel
  ON mpp_deposits(channel_id);

CREATE INDEX IF NOT EXISTS idx_mpp_channels_status
  ON mpp_channels(status, updated_at);
