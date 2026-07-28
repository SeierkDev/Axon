-- The buyer's signature on a purchase.
--
-- AP2 (the payment layer UCP uses) wants non-repudiable proof that the buyer
-- authorised THIS transaction — not a session, not a standing permission, this
-- exact cart at this exact price. So approving a purchase means signing it: the
-- buyer's wallet signs a canonical statement of what they're agreeing to, and
-- that signature is what the business validates before it settles.
--
-- Storing it means the approval survives a failed checkout: if the business is
-- down, the intent stays approved and signed, and completion can be retried
-- without asking the buyer to authorise the same thing twice.
ALTER TABLE purchase_intents ADD COLUMN mandate_message TEXT;
ALTER TABLE purchase_intents ADD COLUMN mandate_signature TEXT;
