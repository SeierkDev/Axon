-- Axon World Arcade: finished minigame runs (v1: the Sky Climb time trial).
-- One row per completed run; leaderboards read best-per-player. Client-reported
-- times with server sanity bounds — a casual in-world leaderboard, not a payout.
CREATE TABLE IF NOT EXISTS arcade_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mode       TEXT    NOT NULL,
  player     TEXT    NOT NULL,
  ms         INTEGER NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_arcade_runs_mode_ms ON arcade_runs(mode, ms);
