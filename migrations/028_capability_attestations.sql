-- Phase 8 (Advanced Protocol Features): capability attestations.
-- A third-party verifier cryptographically vouches that an agent really has a
-- capability it lists. The verifier signs a canonical message with their wallet;
-- the signature is verified on submission. Trust derives from who the verifier
-- is (their identity and reputation) — capabilities are no longer just
-- self-reported.

CREATE TABLE IF NOT EXISTS capability_attestations (
  attestation_id  TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  capability      TEXT NOT NULL,
  verifier        TEXT NOT NULL,   -- wallet address that signed the attestation
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attestations_agent ON capability_attestations (agent_id);
-- One attestation per (agent, capability, verifier).
CREATE UNIQUE INDEX IF NOT EXISTS idx_attestations_unique ON capability_attestations (agent_id, capability, verifier);
