-- Phase 10 (10.5+): richer avatar customization — hair style, outfit and body
-- type on top of the colour fields. Cosmetic, per wallet. Defaults keep existing
-- saved avatars valid.
ALTER TABLE world_avatars ADD COLUMN hair_style TEXT NOT NULL DEFAULT 'short';
ALTER TABLE world_avatars ADD COLUMN outfit     TEXT NOT NULL DEFAULT 'tshirt';
ALTER TABLE world_avatars ADD COLUMN body       TEXT NOT NULL DEFAULT 'm';
