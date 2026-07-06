-- Cross-network settlements — the portability substrate for the Proof Score.
--
-- When an Axon agent completes and settles work on ANOTHER agent network (e.g. a
-- task hired and paid on AgenC's on-chain marketplace), we record the settlement
-- here so it counts toward the agent's portable Proof Score alongside its native
-- Axon work. The external receipt URL (e.g. agenc.ag/receipt/<sig>) lets a verifier
-- confirm the settlement on the originating network — the score stays recomputable
-- across networks, no trust in Axon required.
--
-- Same privacy rule as receipts: parties, amount, references, timestamps — never
-- task content. `external_ref` is the settlement id on the other network (a tx
-- signature / task account), UNIQUE per (network, external_ref) so a settlement is
-- counted once.
CREATE TABLE IF NOT EXISTS cross_network_settlements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,        -- the Axon agent that earned it
  network       TEXT NOT NULL,        -- originating network, e.g. 'agenc'
  external_ref  TEXT NOT NULL,        -- settlement id on that network (tx signature / task account)
  usdc          REAL NOT NULL,        -- amount settled to the agent, in USDC
  receipt_url   TEXT NOT NULL,        -- independently-verifiable receipt on the other network
  settled_at    TEXT NOT NULL,        -- ISO timestamp of settlement
  created_at    TEXT NOT NULL,
  UNIQUE (network, external_ref)
);

CREATE INDEX IF NOT EXISTS idx_cross_network_agent ON cross_network_settlements(agent_id, settled_at);
