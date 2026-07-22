-- "Grow yourself": a budgeted autonomous agent set loose on Axon. One row per
-- experiment run; grow_events is the append-only public timeline of everything
-- it did — every plan, hire, payment, and result — each linkable to a receipt.
-- The money moves through the normal task/payment/transaction tables; this is
-- the narrative ledger that makes the run watchable and provable end to end.
CREATE TABLE IF NOT EXISTS grow_runs (
  run_id        TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,           -- the entrepreneur's own identity
  mission       TEXT NOT NULL,
  budget_usdc   REAL NOT NULL,           -- starting budget (what it was funded with)
  status        TEXT NOT NULL,           -- planning | hiring | synthesizing | completed | failed
  plan          TEXT,                    -- JSON: the sub-tasks it decided on
  deliverable   TEXT,                    -- the final assembled output
  started_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);

CREATE TABLE IF NOT EXISTS grow_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- plan | search | hire | payment | result | synthesis | note | error
  summary      TEXT NOT NULL,
  task_id      TEXT,                     -- links a hire/result to its verifiable receipt (/r/<taskId>)
  to_agent     TEXT,                     -- the specialist that was hired
  amount_usdc  REAL,                     -- what the hire cost, when it's a payment
  data         TEXT,                     -- JSON: any extra detail for the timeline
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grow_events_run ON grow_events(run_id, id);
