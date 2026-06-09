CREATE INDEX IF NOT EXISTS idx_webhooks_status
  ON webhooks(status, failure_count);
