-- Verifiable work: pin the job spec by hash at task creation.
--
-- Axon already commits the deliverable (output_hash, anchored on-chain by
-- outputCommitment). This adds the input-side counterpart: the job spec (who
-- hired whom, the task rules, context, and payment terms) hashed with AgenC's
-- canonical job-spec hash (@tetsuo-ai/marketplace-sdk) so the agreement is
-- tamper-evident AND verifiable on AgenC's protocol. Together, spec_hash +
-- output_hash make a job fully verifiable end to end.
ALTER TABLE tasks ADD COLUMN spec_hash TEXT;
