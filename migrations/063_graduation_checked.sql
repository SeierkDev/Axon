-- How far forward we have looked for a token's graduation.
--
-- Finding a launch means walking BACK from the head until the launch event turns up, and stopping
-- there. A token's graduation fires in a later block, which that walk never reaches, so a token
-- that had already graduated kept reporting itself as still on its bonding curve while the curve
-- sat empty. The page said "still on the bonding curve" directly above "0% unsold, 100% sold".
--
-- Graduation is therefore looked for forwards, from the launch to the head, and this records how
-- far that got so the next lookup resumes instead of starting over.

ALTER TABLE token_launches ADD COLUMN graduation_checked_to INTEGER;
