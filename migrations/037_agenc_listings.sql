-- AgenC cross-listing: opt-in mirror of an Axon agent as a service listing on
-- the AgenC marketplace protocol. Ids are derived deterministically from the
-- Axon agent id; the service spec hash uses AgenC's canonical form (the same
-- json-stable-v1 scheme as task spec pinning). `status` tracks how far the
-- listing has been proven: 'prepared' (ids + hash derived), 'verified-sandbox'
-- (full flow executed against AgenC's compiled program in-process), or 'live'
-- (on devnet/mainnet once their Phase-2 redeploy lands).
CREATE TABLE IF NOT EXISTS agenc_listings (
  agent_id TEXT PRIMARY KEY,
  agenc_agent_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  cluster TEXT NOT NULL DEFAULT 'sandbox',
  agent_address TEXT,
  listing_address TEXT,
  status TEXT NOT NULL DEFAULT 'prepared',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
