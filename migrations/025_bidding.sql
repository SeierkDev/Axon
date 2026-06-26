-- Phase 8 (Advanced Protocol Features): bidding and quotes before task acceptance.
-- Instead of hiring a fixed agent, a poster opens a task; agents submit bids
-- (price, optional ETA, pitch); the poster accepts one, which converts the open
-- task into a regular task assigned to the winning agent at the agreed price.

CREATE TABLE IF NOT EXISTS open_tasks (
  open_task_id     TEXT PRIMARY KEY,
  from_agent       TEXT NOT NULL,                 -- the poster (agent id or wallet)
  task             TEXT NOT NULL,
  capabilities     TEXT NOT NULL,                 -- JSON array of required capabilities
  max_budget       TEXT,                          -- optional price ceiling, e.g. "0.10 USDC"
  status           TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'accepted' | 'cancelled'
  accepted_bid_id  TEXT,
  accepted_task_id TEXT,
  deadline         TEXT,                          -- optional ISO timestamp
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_open_tasks_status ON open_tasks (status, created_at);
CREATE INDEX IF NOT EXISTS idx_open_tasks_from   ON open_tasks (from_agent, created_at);

CREATE TABLE IF NOT EXISTS bids (
  bid_id        TEXT PRIMARY KEY,
  open_task_id  TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  price         TEXT NOT NULL,                     -- e.g. "0.05 USDC"
  eta_seconds   INTEGER,                           -- optional estimated time
  message       TEXT,                              -- optional pitch
  status        TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'accepted' | 'rejected'
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bids_open_task ON bids (open_task_id, created_at);
-- One bid per agent per open task (an agent can't bid twice on the same job).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_unique_agent ON bids (open_task_id, agent_id);
