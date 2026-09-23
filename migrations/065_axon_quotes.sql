-- Quotes for paying in $AXON.
--
-- A quote is a promise about a number that moves. The agent's price is in ETH, the payer sends $AXON,
-- and the rate between them is whatever the pool says at that moment. If verification re-read the rate
-- when the payment arrived, a payer who sent exactly what they were quoted could be refused because
-- the price moved while their transaction was in a block. So the amount is written down here when the
-- quote is issued, and that written amount is the only thing ever checked.
--
-- sqrt_price_x96 is kept beside it. Not used for checking, only so a quote can be explained later:
-- what the pool said, at the moment it was asked.

CREATE TABLE IF NOT EXISTS axon_quotes (
  quote_id        TEXT PRIMARY KEY,
  reference       TEXT,
  eth_wei         TEXT NOT NULL,
  axon_units      TEXT NOT NULL,
  sqrt_price_x96  TEXT NOT NULL,
  pay_to          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  tx_hash         TEXT,
  idempotency_key TEXT
);

-- The same request must never produce two quotes, or a caller that retried has two live prices and
-- can pay whichever is cheaper.
CREATE UNIQUE INDEX IF NOT EXISTS idx_axon_quotes_idem
  ON axon_quotes(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- A transaction settles one quote. Without this, one payment could be presented against several.
CREATE UNIQUE INDEX IF NOT EXISTS idx_axon_quotes_tx
  ON axon_quotes(tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_axon_quotes_created ON axon_quotes(created_at DESC);
