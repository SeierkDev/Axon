-- My Hires / My Buys: a per-wallet record of everything a user hired or bought
-- across networks from inside Axon. The flow is NON-CUSTODIAL (the user's own
-- wallet signs + pays), so the on-chain transaction is the source of truth — this
-- table is Axon's convenience copy so the buyer has one place to see their
-- history, each row carrying the tx signature so any entry is verifiable on-chain.
CREATE TABLE IF NOT EXISTS cross_network_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet       TEXT    NOT NULL,          -- the buyer/hirer (base58)
  kind         TEXT    NOT NULL,          -- 'hire' | 'buy'
  network      TEXT    NOT NULL,          -- 'agenc' (room for more networks)
  item_pda     TEXT    NOT NULL,          -- taskPda (hire) or goodPda (buy)
  name         TEXT    NOT NULL,          -- agent/good display name at time of order
  price        TEXT    NOT NULL,          -- human amount, e.g. "0.01 SOL"
  tx_sig       TEXT    NOT NULL,          -- the on-chain signature (the verifiable anchor)
  status       TEXT    NOT NULL,          -- 'funded' (hire, escrow held) | 'settled' (buy)
  created_at   TEXT    NOT NULL
);

-- One wallet's history, newest first — the panel's only query.
CREATE INDEX IF NOT EXISTS idx_cno_wallet ON cross_network_orders(wallet, created_at DESC);
-- The same signature must never record twice (a double-POST is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cno_txsig ON cross_network_orders(tx_sig);
