// Phase 8: capability attestations from third-party verifiers.
//
// A verifier cryptographically vouches that an agent really has a capability it
// lists. The verifier signs a canonical message with their wallet; we verify the
// signature on submission. Trust derives from who the verifier is, not from a
// platform authority — anyone with a wallet can attest, and consumers weigh an
// attestation by the verifier's identity and reputation.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { getAgentById } from "./agents";
import { verifyWalletSignature } from "./identity";
import { logger } from "./logger";

export interface CapabilityAttestation {
  attestationId: string;
  agentId: string;
  capability: string;
  verifier: string; // wallet address that signed
  createdAt: string;
}

interface AttestationRow {
  attestation_id: string;
  agent_id: string;
  capability: string;
  verifier: string;
  created_at: string;
}

function rowToAttestation(row: AttestationRow): CapabilityAttestation {
  return {
    attestationId: row.attestation_id,
    agentId: row.agent_id,
    capability: row.capability,
    verifier: row.verifier,
    createdAt: row.created_at,
  };
}

// The canonical message a verifier signs to attest an agent's capability.
export function attestationMessage(agentId: string, capability: string): string {
  return `axon-attest:${agentId}:${capability}`;
}

// The canonical message a verifier signs to revoke one of their attestations.
export function revocationMessage(attestationId: string): string {
  return `axon-attest-revoke:${attestationId}`;
}

export type AttestationErrorCode = "INVALID" | "NOT_FOUND" | "DUPLICATE" | "SIGNATURE" | "FORBIDDEN";
export type CreateAttestationResult =
  | { success: true; attestation: CapabilityAttestation }
  | { success: false; error: string; code: AttestationErrorCode };

export interface CreateAttestationInput {
  agentId: string;
  capability: string;
  verifier: string; // wallet address
  signature: string; // base64 signature over attestationMessage(agentId, capability)
}

export function createAttestation(input: CreateAttestationInput): CreateAttestationResult {
  const agent = getAgentById(input.agentId);
  if (!agent) return { success: false, error: `Agent '${input.agentId}' not found`, code: "NOT_FOUND" };

  // An attestation only means something if the agent actually lists the capability.
  if (!agent.capabilities.includes(input.capability)) {
    return { success: false, error: `Agent '${input.agentId}' does not list capability '${input.capability}'`, code: "INVALID" };
  }

  // An owner vouching for their own agent is worthless — block self-attestation.
  if (agent.walletAddress && agent.walletAddress === input.verifier) {
    return { success: false, error: "An agent's owner cannot attest its own capabilities", code: "FORBIDDEN" };
  }

  // The signature proves the verifier vouches — this is the only auth required.
  const ok = verifyWalletSignature({
    walletAddress: input.verifier,
    message: attestationMessage(input.agentId, input.capability),
    signatureB64: input.signature,
  });
  if (!ok) {
    return { success: false, error: "Signature does not verify for the given verifier wallet", code: "SIGNATURE" };
  }

  const db = getDb();
  const attestationId = randomUUID();
  const createdAt = new Date().toISOString();
  try {
    db.prepare(
      "INSERT INTO capability_attestations (attestation_id, agent_id, capability, verifier, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(attestationId, input.agentId, input.capability, input.verifier, createdAt);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      return { success: false, error: "This verifier has already attested this capability", code: "DUPLICATE" };
    }
    throw err;
  }
  void syncToTurso();
  logger.info("attestation.created", "Capability attestation created", {
    agentId: input.agentId,
    capability: input.capability,
    verifier: input.verifier,
  });
  return { success: true, attestation: getAttestationById(attestationId)! };
}

export function getAttestationById(attestationId: string): CapabilityAttestation | null {
  const row = getDb()
    .prepare("SELECT * FROM capability_attestations WHERE attestation_id = ?")
    .get(attestationId) as AttestationRow | undefined;
  return row ? rowToAttestation(row) : null;
}

// Bounded so a flood of attestations (anyone with a wallet can submit one) can't
// produce an unbounded response. 500 is far more than any agent legitimately accrues.
const MAX_ATTESTATIONS_RETURNED = 500;

export function getAttestationsForAgent(agentId: string): CapabilityAttestation[] {
  const rows = getDb()
    .prepare("SELECT * FROM capability_attestations WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(agentId, MAX_ATTESTATIONS_RETURNED) as AttestationRow[];
  return rows.map(rowToAttestation);
}

export type RevokeResult = { success: true } | { success: false; error: string; code: "NOT_FOUND" | "SIGNATURE" };

// Revoke an attestation — only the original verifier can, proven by a signature
// over the revocation message.
export function revokeAttestation(attestationId: string, signature: string): RevokeResult {
  const attestation = getAttestationById(attestationId);
  if (!attestation) return { success: false, error: "Attestation not found", code: "NOT_FOUND" };

  const ok = verifyWalletSignature({
    walletAddress: attestation.verifier,
    message: revocationMessage(attestationId),
    signatureB64: signature,
  });
  if (!ok) return { success: false, error: "Signature does not verify for the attesting verifier", code: "SIGNATURE" };

  getDb().prepare("DELETE FROM capability_attestations WHERE attestation_id = ?").run(attestationId);
  void syncToTurso();
  logger.info("attestation.revoked", "Capability attestation revoked", { attestationId, verifier: attestation.verifier });
  return { success: true };
}
