CREATE TABLE IF NOT EXISTS audit_events (
  audit_id       TEXT PRIMARY KEY,
  actor_wallet   TEXT NOT NULL,
  actor_key_id   TEXT,
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT NOT NULL,
  owner_agent_id TEXT,
  owner_wallet   TEXT,
  ip             TEXT,
  metadata       TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_owner_wallet
  ON audit_events(owner_wallet, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_owner_agent
  ON audit_events(owner_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_resource
  ON audit_events(resource_type, resource_id, created_at);
