import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  createAttestation,
  getAttestationsForAgent,
  revokeAttestation,
  attestationMessage,
  revocationMessage,
} from "@/lib/attestations";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";

let counter = 0;
function makeAgent(capabilities = ["research"]): { agent: Agent; keypair: Keypair } {
  counter++;
  const keypair = Keypair.generate();
  const agent: Agent = {
    agentId: `att-${counter}`,
    name: `Attest Agent ${counter}`,
    capabilities,
    publicKey: `pk-att-${counter}`,
    walletAddress: keypair.publicKey.toBase58(),
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(agent);
  return { agent, keypair };
}

function sign(keypair: Keypair, message: string): string {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)).toString("base64");
}

describe("capability attestations", () => {
  it("accepts a validly-signed attestation and lists it", () => {
    const { agent } = makeAgent(["research"]);
    const verifier = Keypair.generate();
    const sig = sign(verifier, attestationMessage(agent.agentId, "research"));

    const r = createAttestation({ agentId: agent.agentId, capability: "research", verifier: verifier.publicKey.toBase58(), signature: sig });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(getAttestationsForAgent(agent.agentId).some((a) => a.attestationId === r.attestation.attestationId)).toBe(true);
  });

  it("rejects a signature that doesn't match the verifier", () => {
    const { agent } = makeAgent(["research"]);
    const verifier = Keypair.generate();
    const wrongSigner = Keypair.generate();
    // Signed by the wrong key for the claimed verifier.
    const sig = sign(wrongSigner, attestationMessage(agent.agentId, "research"));
    const r = createAttestation({ agentId: agent.agentId, capability: "research", verifier: verifier.publicKey.toBase58(), signature: sig });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("SIGNATURE");
  });

  it("rejects an attestation for a capability the agent does not list", () => {
    const { agent } = makeAgent(["research"]);
    const verifier = Keypair.generate();
    const sig = sign(verifier, attestationMessage(agent.agentId, "coding"));
    const r = createAttestation({ agentId: agent.agentId, capability: "coding", verifier: verifier.publicKey.toBase58(), signature: sig });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("rejects an unknown agent", () => {
    const verifier = Keypair.generate();
    const sig = sign(verifier, attestationMessage("no-such-agent", "research"));
    const r = createAttestation({ agentId: "no-such-agent", capability: "research", verifier: verifier.publicKey.toBase58(), signature: sig });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });

  it("blocks self-attestation by the agent's own owner", () => {
    const { agent, keypair } = makeAgent(["research"]);
    // The owner signs with the agent's own wallet.
    const sig = sign(keypair, attestationMessage(agent.agentId, "research"));
    const r = createAttestation({ agentId: agent.agentId, capability: "research", verifier: agent.walletAddress!, signature: sig });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("FORBIDDEN");
  });

  it("rejects a duplicate attestation from the same verifier", () => {
    const { agent } = makeAgent(["research"]);
    const verifier = Keypair.generate();
    const sig = sign(verifier, attestationMessage(agent.agentId, "research"));
    createAttestation({ agentId: agent.agentId, capability: "research", verifier: verifier.publicKey.toBase58(), signature: sig });
    const dup = createAttestation({ agentId: agent.agentId, capability: "research", verifier: verifier.publicKey.toBase58(), signature: sig });
    expect(dup.success).toBe(false);
    if (!dup.success) expect(dup.code).toBe("DUPLICATE");
  });

  it("revokes an attestation with a valid verifier signature", () => {
    const { agent } = makeAgent(["research"]);
    const verifier = Keypair.generate();
    const created = createAttestation({
      agentId: agent.agentId,
      capability: "research",
      verifier: verifier.publicKey.toBase58(),
      signature: sign(verifier, attestationMessage(agent.agentId, "research")),
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const revokeSig = sign(verifier, revocationMessage(created.attestation.attestationId));
    const r = revokeAttestation(created.attestation.attestationId, revokeSig);
    expect(r.success).toBe(true);
    expect(getAttestationsForAgent(agent.agentId).length).toBe(0);
  });

  it("rejects revocation with a non-verifier signature", () => {
    const { agent } = makeAgent(["research"]);
    const verifier = Keypair.generate();
    const created = createAttestation({
      agentId: agent.agentId,
      capability: "research",
      verifier: verifier.publicKey.toBase58(),
      signature: sign(verifier, attestationMessage(agent.agentId, "research")),
    });
    if (!created.success) return;
    const attacker = Keypair.generate();
    const r = revokeAttestation(created.attestation.attestationId, sign(attacker, revocationMessage(created.attestation.attestationId)));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("SIGNATURE");
  });

  it("rejects revoking an unknown attestation", () => {
    const verifier = Keypair.generate();
    const r = revokeAttestation(randomUUID(), sign(verifier, revocationMessage("x")));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });
});
