-- Stores generated Axon Build games so they can be served from a real URL
-- (the /play/<id> page and the download endpoint) instead of fragile
-- client-side blob:/data: URLs, which the page CSP and mobile browsers block.
CREATE TABLE IF NOT EXISTS build_games (
  build_id    TEXT PRIMARY KEY,
  prompt      TEXT NOT NULL,
  html        TEXT NOT NULL,
  qa_passed   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_build_games_created ON build_games(created_at);
