-- Telegram bot post history and milestone deduplication
CREATE TABLE IF NOT EXISTS telegram_posts (
  post_id    TEXT PRIMARY KEY,
  type       TEXT NOT NULL, -- 'snapshot' | 'agent' | 'task_milestone' | 'usdc_milestone'
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_posts_created ON telegram_posts(created_at DESC);

-- Tracks which milestones have already been announced so we never fire twice
CREATE TABLE IF NOT EXISTS telegram_milestones (
  key          TEXT PRIMARY KEY,
  value        REAL NOT NULL,
  announced_at TEXT NOT NULL
);
