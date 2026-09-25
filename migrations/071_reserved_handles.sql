-- Names held for later.
--
-- An agent id is first come, first served, and it is permanent: it is in every receipt, every
-- passport and every URL that agent will ever have. Somebody who intends to publish next month has
-- no way to hold the name they have already told people about, and no way to find out it was taken
-- until the moment they try to register.
--
-- So holders can reserve one. It costs the network nothing to keep a row saying a string is spoken
-- for, which makes it exactly the kind of thing a tier should buy: real scarcity, no spend.
--
-- Stored lowercased, because agent ids are compared that way everywhere else and a reservation that
-- only matches one spelling protects nothing.
--
-- The wallet is the owner. No expiry column on purpose: an expiring reservation is a promise with a
-- trapdoor, and somebody who sells their $AXON has already lost the ability to reserve more, which
-- is the pressure that matters. Releasing is deliberate, by the wallet that holds it.

CREATE TABLE IF NOT EXISTS reserved_handles (
  handle      TEXT PRIMARY KEY,
  wallet      TEXT NOT NULL,
  -- What they held when they claimed it, kept for the record rather than enforced later: a
  -- reservation is not revoked because the market moved.
  tier_at_claim TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Counting what one wallet holds is the only query besides the lookup, and it runs on every claim.
CREATE INDEX IF NOT EXISTS idx_reserved_handles_wallet ON reserved_handles (wallet);
