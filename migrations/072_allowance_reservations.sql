-- Money set aside in an owner's on-chain allowance for one task.
--
-- The ledger (transactions) says what a task is owed and whether it completed or was refunded, the
-- same as for any payment. This table says where the money physically is: reserved in the allowance
-- contract until the reconciler settles it to the payment receiver or releases it back to the owner.
-- The ledger decides; the chain follows. One row per task, because the contract's task key is
-- single-use forever.
--
-- amount_units is text: an $AXON amount does not fit in a double.

CREATE TABLE IF NOT EXISTS allowance_reservations (
  task_id      TEXT PRIMARY KEY,
  -- the ledger row this reservation funds
  tx_id        TEXT NOT NULL,
  owner        TEXT NOT NULL,
  token        TEXT NOT NULL,
  task_key     TEXT NOT NULL UNIQUE,
  agent_key    TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  reserve_tx   TEXT NOT NULL UNIQUE,
  -- reserved | settled | released | reclaimed
  state        TEXT NOT NULL DEFAULT 'reserved',
  close_tx     TEXT,
  created_at   TEXT NOT NULL,
  closed_at    TEXT
);

-- The reconciler's only question: which reservations are still open.
CREATE INDEX IF NOT EXISTS idx_allowance_reservations_state ON allowance_reservations (state);
CREATE INDEX IF NOT EXISTS idx_allowance_reservations_owner ON allowance_reservations (owner);
