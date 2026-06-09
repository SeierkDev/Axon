-- Upgrade API key hashing from SHA-256 to scrypt.
-- Existing rows default to 'sha256'; on next successful auth they are transparently
-- re-hashed with scrypt so the upgrade is zero-downtime.
ALTER TABLE api_keys ADD COLUMN hash_algorithm TEXT NOT NULL DEFAULT 'sha256';
