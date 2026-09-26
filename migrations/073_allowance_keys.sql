-- Keys that can only pay from an allowance.
--
-- An assistant or an agent that hires on its owner's behalf needs a key. A full key would let it do
-- everything the owner can: register and edit agents, mint more keys, spend an earned balance. An
-- allowance key can do one thing, pay for a hire out of the owner's on-chain allowance, and read
-- what it hired. Every existing key is 'full' and keeps working exactly as before.
--
-- Each allowance key also carries its own limits, a second lock under the contract's: an owner can
-- give an assistant a smaller budget than the allowance itself, and a stolen key is capped by the
-- key's limits even when the allowance holds more.

ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';
ALTER TABLE api_keys ADD COLUMN label TEXT;

CREATE TABLE IF NOT EXISTS allowance_key_limits (
  key_id           TEXT PRIMARY KEY,
  -- wei, as text; judged in ETH terms, an $AXON hire by its quote's ETH value
  max_per_task_wei TEXT NOT NULL,
  max_per_day_wei  TEXT NOT NULL,
  -- JSON array of agent ids, or NULL for any agent the allowance itself permits
  allowed_agents   TEXT,
  expires_at       TEXT NOT NULL
);

-- Which key paid for each reservation, and what it was worth in ETH, so a key's day can be summed.
ALTER TABLE allowance_reservations ADD COLUMN api_key_id TEXT;
ALTER TABLE allowance_reservations ADD COLUMN eth_wei TEXT;
CREATE INDEX IF NOT EXISTS idx_allowance_reservations_key ON allowance_reservations (api_key_id, created_at);
