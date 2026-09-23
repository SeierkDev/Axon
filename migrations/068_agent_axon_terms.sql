-- Whether an agent takes $AXON, and what it charges when it does.
--
-- Both default to the agent doing nothing differently: not taking the token, and no discount if it
-- ever does. An agent that was registered before any of this existed must not start quoting in a
-- currency its owner never agreed to, so opting in is an act rather than an absence.
--
-- The discount is the lever an agent actually pulls. Paying in $AXON is worth something to the
-- network, and this is where an agent decides how much of that it wants to pass on: a dial the agent
-- turns, rather than a policy applied to everyone from above.

ALTER TABLE agents ADD COLUMN accepts_axon INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN axon_discount_bps INTEGER NOT NULL DEFAULT 0;
