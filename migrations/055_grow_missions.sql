-- Missions: grow-yourself, opened up to every owner.
--
-- The engine already existed as a single platform experiment driven by env vars.
-- These columns make a run belong to somebody: who owns it, the caps it was
-- started with, and whether its owner has called it off. Existing platform runs
-- have a NULL owner_wallet and stay exactly as they were.
ALTER TABLE grow_runs ADD COLUMN owner_wallet TEXT;
ALTER TABLE grow_runs ADD COLUMN per_hire_cap_usdc REAL;
ALTER TABLE grow_runs ADD COLUMN max_hires INTEGER;
-- Cooperative cancellation: the runner checks this between steps, so a mission
-- stops at the next safe point rather than mid-payment.
ALTER TABLE grow_runs ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_grow_runs_owner ON grow_runs(owner_wallet, started_at DESC);

-- grow_events.kind gained "review" and "self" with Missions. The authoritative
-- list lives on GrowEventKind in src/lib/grow.ts; 048's comment is deliberately
-- left as it was, because editing an applied migration changes its checksum and
-- makes every boot warn about it.
