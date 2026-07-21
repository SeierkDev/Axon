-- Distinguishes how a paid task was funded, so an agent's spendable EARNED
-- balance can be computed correctly. A hire funded on-chain (or via an MPP
-- channel) is paid from an external source that flows through the receiver
-- wallet — it must NOT reduce the agent's pool credit. A hire funded from
-- balance (funding_source = 'balance') draws down that credit and is the only
-- kind getAvailableBalance() subtracts. NULL = external/on-chain (the default,
-- and correct for every pre-existing row).
ALTER TABLE transactions ADD COLUMN funding_source TEXT;
