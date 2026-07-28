-- Auto-approve removes the decision, not the signature.
--
-- AP2 requires the buyer to sign every individual purchase on a surface the
-- agent doesn't control, so an intent can never skip straight to 'approved' —
-- one that did could never be completed, because completion needs that
-- signature. What the mandate's threshold can do is tell the buyer they don't
-- need to think about this one: it's already within a limit they set. They still
-- sign, they just don't have to decide.
ALTER TABLE purchase_intents ADD COLUMN pre_cleared INTEGER NOT NULL DEFAULT 0;
