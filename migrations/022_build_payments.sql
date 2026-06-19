-- Records consumed payment signatures for paid Axon Build generations, so a
-- single on-chain USDC payment cannot be replayed to generate multiple games.
CREATE TABLE IF NOT EXISTS build_payments (
  signature  TEXT PRIMARY KEY,
  payer      TEXT,
  build_id   TEXT,
  used_at    TEXT NOT NULL
);
