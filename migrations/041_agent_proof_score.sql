-- Cached Proof Score on the agent row — mirrors the cached `reputation` column.
--
-- computeProofScore is derived (reputation + settled work + cross-network), so
-- computing it per agent on every list view (marketplace directory, search API)
-- is wasteful at scale. Cache the score + tier here, refreshed on task completion
-- and by the daily recompute cron (same lifecycle as reputation). List views read
-- these columns directly; the full proof (evidence, hash) is still computed live
-- on the single-agent profile + /api/agents/<id>/proof-score.
--
-- Nullable on purpose: NULL = not yet computed (backfilled by the recompute run),
-- distinct from a real 0. rowToAgent maps NULL -> undefined (no badge shown).
ALTER TABLE agents ADD COLUMN proof_score INTEGER;
ALTER TABLE agents ADD COLUMN proof_score_tier TEXT;
