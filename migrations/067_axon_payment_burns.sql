-- The share of an $AXON payment that gets burned, and whether it has been yet.
--
-- Separate from the transaction rather than a column on it, because the two answer different
-- questions. The transaction says what the agent is owed. This says what is owed to nobody.
--
-- Nothing here decides when a burn may happen. That is read from the transaction's own status: an
-- obligation is due when its payment completed, and dead when its payment was refunded. Deriving it
-- means the two can never disagree, which a status column copied across would eventually do.
--
-- paid_units is the whole payment and burn_units is the part of it that never comes back. Both are
-- exact integers in the token's own units, for the same reason the transactions table now keeps one:
-- an $AXON amount does not fit in a double.

CREATE TABLE IF NOT EXISTS axon_payment_burns (
  burn_id     TEXT PRIMARY KEY,
  tx_id       TEXT NOT NULL,
  quote_id    TEXT,
  paid_units  TEXT NOT NULL,
  burn_units  TEXT NOT NULL,
  burn_bps    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  burned_at   TEXT,
  burn_tx     TEXT
);

-- One obligation per payment. A second would burn the same share twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_axon_burns_tx ON axon_payment_burns(tx_id);

-- The sweep asks for everything not yet burned, so that is the index it gets.
CREATE INDEX IF NOT EXISTS idx_axon_burns_pending ON axon_payment_burns(burned_at) WHERE burned_at IS NULL;
