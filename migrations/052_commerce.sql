-- Agents that buy things.
--
-- The "commerce" tool grant lets an agent shop and check out over the Universal
-- Commerce Protocol (UCP): discover a business at /.well-known/ucp, search its
-- catalogue, build a cart, and complete a checkout session. Axon executes the
-- calls; the agent never touches the buyer's details.
--
-- Three tables, one per thing that has to be true before real money moves:
--   commerce_profiles  WHO the goods go to        (per owner, encrypted, never traced)
--   spend_mandates     HOW MUCH an agent may spend (standing authority, revocable)
--   purchase_intents   WHAT was proposed/approved  (single-use, price-bound, expiring)

-- Where a buyer's orders ship, and how they pay. Belongs to the OWNER (a wallet),
-- not to an agent: an agent is granted the capability, never the credentials.
-- contact/address are AES-256-GCM envelopes (src/lib/crypto.ts) because receipts
-- are public and this is the one class of data that must never reach a trace.
CREATE TABLE IF NOT EXISTS commerce_profiles (
  profile_id      TEXT PRIMARY KEY,
  owner_wallet    TEXT NOT NULL,
  label           TEXT NOT NULL,
  contact_enc     TEXT NOT NULL,          -- encrypted JSON: name, email, phone
  address_enc     TEXT NOT NULL,          -- encrypted JSON: shipping address
  payment_handler TEXT,                   -- UCP payment handler id negotiated at checkout
  status          TEXT NOT NULL DEFAULT 'active',   -- active | frozen
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commerce_profiles_owner ON commerce_profiles(owner_wallet);

-- Standing authority: "this agent may spend up to X per period against this
-- profile". Distinct from per-purchase approval — two different consents, and
-- conflating them is how people get surprised by their own agent.
CREATE TABLE IF NOT EXISTS spend_mandates (
  mandate_id       TEXT PRIMARY KEY,
  owner_wallet     TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  profile_id       TEXT NOT NULL,
  max_per_purchase REAL NOT NULL,
  max_per_period   REAL NOT NULL,
  period           TEXT NOT NULL DEFAULT 'month',  -- day | week | month
  currency         TEXT NOT NULL DEFAULT 'USD',
  -- Below this, the agent may buy without asking. 0 (the default) means every
  -- purchase needs an explicit approval.
  auto_approve_under REAL NOT NULL DEFAULT 0,
  allowed_hosts    TEXT,                   -- JSON array; null = any UCP business
  status           TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  revoked_at       TEXT,
  FOREIGN KEY (profile_id) REFERENCES commerce_profiles(profile_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_spend_mandates_agent ON spend_mandates(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_spend_mandates_owner ON spend_mandates(owner_wallet, status);

-- One proposed purchase. The row IS the idempotency key: a task that retries
-- cannot buy twice, because completing an intent flips it out of 'approved' in
-- the same transaction that records the order.
CREATE TABLE IF NOT EXISTS purchase_intents (
  intent_id     TEXT PRIMARY KEY,
  task_id       TEXT,
  agent_id      TEXT NOT NULL,
  owner_wallet  TEXT NOT NULL,
  mandate_id    TEXT NOT NULL,
  profile_id    TEXT NOT NULL,
  business_host TEXT NOT NULL,            -- the UCP business the cart lives on
  summary       TEXT NOT NULL,            -- human-readable line items, for the approval
  items_hash    TEXT NOT NULL,            -- commits to the exact cart contents
  -- The approval binds to a ceiling, not a quote: approve $180 at 9am and the
  -- checkout cannot silently settle at $210.
  amount        REAL NOT NULL,
  max_amount    REAL NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  status        TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | purchased | declined | expired | failed
  checkout_id   TEXT,                     -- UCP checkout session id
  order_id      TEXT,                     -- business order id once complete
  order_status  TEXT,                     -- post-purchase state from UCP order management
  failure       TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  purchased_at  TEXT,
  FOREIGN KEY (mandate_id) REFERENCES spend_mandates(mandate_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_purchase_intents_owner ON purchase_intents(owner_wallet, status);
CREATE INDEX IF NOT EXISTS idx_purchase_intents_agent ON purchase_intents(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_intents_task ON purchase_intents(task_id);
