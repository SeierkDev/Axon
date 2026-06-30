-- Phase 9: standalone created_at indexes for the public network explorer.
-- getRecentTasks / getRecentSettlements run `ORDER BY created_at DESC LIMIT N`
-- with no WHERE clause. The existing composite (status, created_at) indexes
-- can't serve a pure created_at ordering (status is the leading column), so
-- those queries were full table scans + sorts that degrade as the tables grow.
-- A standalone created_at index lets SQLite reverse-scan and stop after N rows.

CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions (created_at);
