-- Who launched what, on Robinhood Chain.
--
-- The chain does roughly twenty thousand launches a day and keeps no state older than about a
-- thousand blocks, so there is no way to ask it "who deployed this token" after the fact. The
-- answer only exists in the factory's logs, and the node will not serve a range wider than a
-- hundred thousand blocks, which is under three hours of them.
--
-- So launches are written down the first time they are seen. A scan for one token brings back
-- every launch in the same window anyway, so each lookup fills the table for thousands of others
-- and the next one is free.
--
-- The creator is the reason this table exists. A wallet that has launched forty tokens this week
-- is the single most useful thing a buyer can know about the forty-first, and nothing else on this
-- chain will tell them.

CREATE TABLE IF NOT EXISTS token_launches (
  token         TEXT PRIMARY KEY,   -- the token contract, lowercased
  creator       TEXT NOT NULL,      -- the wallet that launched it
  curve         TEXT NOT NULL,      -- its bonding curve
  block_number  INTEGER NOT NULL,
  tx_hash       TEXT NOT NULL,
  graduated_at  INTEGER,            -- block it reached the curve's target, null while still on it
  seen_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_launches_creator ON token_launches(creator, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_launches_block   ON token_launches(block_number DESC);

-- Which ranges of the chain have actually been read, so a gap is never mistaken for an absence.
-- Without this, "no launches found for this wallet" could mean either.
CREATE TABLE IF NOT EXISTS launch_scan_ranges (
  from_block  INTEGER NOT NULL,
  to_block    INTEGER NOT NULL,
  scanned_at  TEXT NOT NULL,
  PRIMARY KEY (from_block, to_block)
);
