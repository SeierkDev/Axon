-- Phase 10: character creator — hat STYLE (cowboy/cap/beanie/bucket) and a custom
-- display name, on top of the existing avatar fields. Cosmetic, per wallet.
ALTER TABLE world_avatars ADD COLUMN hat_style TEXT NOT NULL DEFAULT 'none';
ALTER TABLE world_avatars ADD COLUMN name      TEXT;
