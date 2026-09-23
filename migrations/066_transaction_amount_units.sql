-- The exact amount, for rows that are not denominated in ETH.
--
-- amount_eth is a REAL, and a double holds an ETH amount fine because those are small: 0.00025 has
-- plenty of room. An $AXON amount does not. A job priced at 0.00025 ETH is about 8,755.507678171916
-- tokens with another six digits after that, and the double keeps only the first sixteen. The ledger
-- would then say a slightly different number from the one the chain actually moved.
--
-- Nothing about that is expensive: the lost part is worth a hundred-millionth of a cent. It is still
-- the ledger disagreeing with the chain, and this file exists on the principle that a decimal is for
-- reading and the integer is what money is actually counted in.
--
-- Null for every ETH row, which is all of them so far. amount_eth stays as it is, for display and for
-- every aggregate that already reads it.

ALTER TABLE transactions ADD COLUMN amount_units TEXT;
