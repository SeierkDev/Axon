-- Burns, kept.
--
-- The burn page reads the pot's Burned events straight off the chain, which works and is the
-- right source, but a log query can only reach back so far: this chain makes a block every tenth
-- of a second and the node refuses a range wider than a hundred thousand of them. That puts a
-- horizon about eight hours behind the head, and a burn older than that disappears from the page
-- as if it never happened.
--
-- So each one is written down the first time it is seen. The chain stays the source of truth and
-- keeps being read for new ones; this is the part that remembers.

CREATE TABLE IF NOT EXISTS burns (
  n              INTEGER PRIMARY KEY,   -- the pot's own burn number, so a burn can only land once
  tx_hash        TEXT    NOT NULL UNIQUE,
  block_number   INTEGER NOT NULL,
  eth_in         REAL    NOT NULL,
  tokens_out     REAL    NOT NULL,
  caller         TEXT    NOT NULL,      -- the engine for most of them, anyone at all for the rest
  recorded_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_burns_block ON burns(block_number DESC);
