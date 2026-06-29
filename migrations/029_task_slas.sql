-- Phase 8 (final): agent-to-agent SLAs with automatic penalties.
--
-- A task may carry a service-level agreement: a completion deadline and a
-- penalty (basis points of the escrowed payment) the provider forfeits to the
-- client if the deadline is breached. Enforcement is automatic —
--   * late-but-delivered  → at settlement the provider's payout is docked by
--     penalty_bps and that portion is refunded to the client;
--   * never-delivered      → a periodic sweep fails the task once the deadline
--     passes while it is still queued/running and refunds the client in full.
-- The client (the task's from_agent / payer) sets the terms, mirroring how
-- escrow splits are defined by the payer.

CREATE TABLE IF NOT EXISTS task_slas (
  sla_id       TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL UNIQUE,
  deadline_at  TEXT NOT NULL,
  penalty_bps  INTEGER NOT NULL,           -- basis points (1..10000) forfeited on breach
  status       TEXT NOT NULL DEFAULT 'active',  -- active | met | breached
  resolved_at  TEXT,
  created_at   TEXT NOT NULL
);

-- The sweep scans for active SLAs whose deadline has passed.
CREATE INDEX IF NOT EXISTS idx_task_slas_status_deadline ON task_slas (status, deadline_at);
