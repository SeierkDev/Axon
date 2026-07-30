-- The mission gallery: templates to start from, and results worth showing.
--
-- `published` is opt-in and reversible. A mission receipt is content-free by
-- design — it holds hashes, never the brief or the result. Publishing is the
-- opposite: it puts the actual words on a public page. That is a deliberate act
-- by the owner, never a default, which is why this defaults to 0 and why
-- unpublishing has to work.
--
-- `template_id` records which preset a mission started from, so a published
-- result can offer "run this yourself" and point at the same starting point.
ALTER TABLE grow_runs ADD COLUMN published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE grow_runs ADD COLUMN published_at TEXT;
ALTER TABLE grow_runs ADD COLUMN template_id TEXT;

-- The gallery reads newest-published-first; nothing else queries on this.
CREATE INDEX IF NOT EXISTS idx_grow_runs_published
  ON grow_runs(published, published_at DESC);
