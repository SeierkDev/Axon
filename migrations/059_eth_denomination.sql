-- Everything is denominated in the chain's native ETH now, so the column names say so.
--
-- These are renames, not conversions: the numbers already in these columns were written under the
-- old denomination and mean nothing under the new one. There is no rate to convert them at and
-- inventing one would be worse than leaving them, so the relaunch starts from a fresh ledger and
-- whatever is still here is historical.
--
-- amount_sol was already the wrong name before this, because it held USDC amounts too with the
-- currency in a separate column. One name for one thing.

ALTER TABLE transactions RENAME COLUMN amount_sol TO amount_eth;

ALTER TABLE agent_budgets RENAME COLUMN max_per_call_usdc TO max_per_call_eth;
ALTER TABLE agent_budgets RENAME COLUMN max_per_day_usdc  TO max_per_day_eth;

ALTER TABLE mpp_channels RENAME COLUMN balance_usdc TO balance_eth;
ALTER TABLE mpp_debits   RENAME COLUMN amount_usdc  TO amount_eth;
ALTER TABLE mpp_deposits RENAME COLUMN amount_usdc  TO amount_eth;

-- The exact-unit columns are REPLACED rather than renamed. They held micro-USDC in an INTEGER, and
-- wei does not fit one: a 64-bit column tops out around 9 ETH, and a JS number around 0.009 ETH.
-- Silently truncating a balance is how someone spends money they never deposited, so these become
-- TEXT holding a decimal wei string, read back as a BigInt.
ALTER TABLE mpp_channels DROP COLUMN balance_micro_usdc;
ALTER TABLE mpp_channels ADD COLUMN balance_wei TEXT NOT NULL DEFAULT '0';

ALTER TABLE mpp_debits DROP COLUMN amount_micro_usdc;
ALTER TABLE mpp_debits ADD COLUMN amount_wei TEXT NOT NULL DEFAULT '0';

ALTER TABLE mpp_deposits DROP COLUMN amount_micro_usdc;
ALTER TABLE mpp_deposits ADD COLUMN amount_wei TEXT NOT NULL DEFAULT '0';

ALTER TABLE spend_thresholds RENAME COLUMN threshold_usdc TO threshold_eth;

ALTER TABLE spend_alerts RENAME COLUMN amount_usdc    TO amount_eth;
ALTER TABLE spend_alerts RENAME COLUMN threshold_usdc TO threshold_eth;

ALTER TABLE cross_network_settlements RENAME COLUMN usdc TO amount_eth;

ALTER TABLE grow_runs   RENAME COLUMN budget_usdc       TO budget_eth;
ALTER TABLE grow_runs   RENAME COLUMN per_hire_cap_usdc TO per_hire_cap_eth;
ALTER TABLE grow_events RENAME COLUMN amount_usdc       TO amount_eth;

-- Balances carried over from the old denomination are not balances any more.
UPDATE mpp_channels SET balance_eth = 0, balance_wei = '0';

-- Every price written under the old denomination is unusable as a price now. Clearing them is
-- honest: an agent with no price reads as free, rather than as costing an amount nobody set.
UPDATE agents SET price = NULL WHERE price IS NOT NULL;
