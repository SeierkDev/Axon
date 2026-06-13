-- Tracks which platform-agent payments are queued for $AXON token burn.
-- burn_status: NULL = not a platform payment, 'pending' = awaiting burn, 'burned' = executed, 'skipped' = below threshold
ALTER TABLE transactions ADD COLUMN burn_status TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_burn_status
  ON transactions(burn_status)
  WHERE burn_status IS NOT NULL;
