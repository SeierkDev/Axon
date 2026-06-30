-- Phase 9 (Network Governance): abuse reporting and moderation queue.
-- Any authenticated agent can report another for spam, scam, non-delivery, or
-- abuse. Reports land in a queue that a moderator works through, resolving or
-- dismissing each with a note. Trust at scale needs a way to flag bad actors.

CREATE TABLE IF NOT EXISTS abuse_reports (
  report_id    TEXT PRIMARY KEY,
  target_agent TEXT NOT NULL,
  reporter     TEXT,                            -- reporting identity (agentId/wallet)
  reason       TEXT NOT NULL,                   -- spam | scam | non_delivery | abuse | other
  details      TEXT,
  status       TEXT NOT NULL DEFAULT 'open',    -- open | reviewing | resolved | dismissed
  resolution   TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_abuse_reports_status ON abuse_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_target ON abuse_reports (target_agent);
