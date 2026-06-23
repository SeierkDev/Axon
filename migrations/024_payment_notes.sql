-- Phase 6 (Marketplace Trust Layer): dispute and refund notes attached to receipts.
-- A short, human-readable note tied to a task's payment — why it was refunded, or a
-- dispute one of the parties wants on the record — surfaced on the task receipt.
CREATE TABLE IF NOT EXISTS payment_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- 'dispute' | 'refund' | 'note'
  note        TEXT NOT NULL,
  author      TEXT,            -- wallet that attached it; NULL for system-generated
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_notes_task
  ON payment_notes (task_id, created_at);
