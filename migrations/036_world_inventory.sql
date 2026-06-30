-- Phase 10: per-wallet Axon World inventory (minigame collectibles).
-- Guests keep items in memory only; connected wallets persist them here.
CREATE TABLE IF NOT EXISTS world_inventory (
  wallet TEXT PRIMARY KEY,
  items TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
