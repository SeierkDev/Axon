-- Phase 10 (10.5): Axon World avatars.
--
-- Cosmetic, per-wallet character customization for the walkable world — the
-- colours of your low-poly avatar (skin, hair, shirt, trousers, optional hat).
-- Keyed by wallet address so your look follows you across sessions. Purely
-- decorative: no funds, no auth-critical data.
CREATE TABLE IF NOT EXISTS world_avatars (
  wallet     TEXT PRIMARY KEY,
  skin       TEXT NOT NULL,
  hair       TEXT NOT NULL,
  shirt      TEXT NOT NULL,
  pants      TEXT NOT NULL,
  hat        TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
