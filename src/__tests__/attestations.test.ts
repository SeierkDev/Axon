import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import {
  createAttestation,
  getAttestationsForAgent,
  revokeAttestation,
  attestationMessage,
  revocationMessage,
} from "@/lib/attestations";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { testWallet, type TestWallet } from "./support/wallet";

let counter = 0;
function makeAgent(capabilities = ["research"]): { agent: Agent; owner: TestWallet } {
  counter++;
  const owner = testWallet();
  const agent: Agent = {
    agentId: `att-${counter}`,
    name: `Attest Agent ${counter}`,
    capabilities,
    publicKey: `pk-att-${counter}`,
    walletAddress: owner.address,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(agent);
  return { agent, owner };
}

describe("capability attestations", () => {
  it("accepts a validly-signed attestation and lists it", async () => {
    const { agent } = makeAgent(["research"]);
    const verifier = testWallet();
    const sig = await verifier.sign(attestationMessage(agent.agentId, "research"));

    const r = await createAttestation({ agentId: agent.agentId, capability: "research", verifier: verifier.address, signature: sig });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(getAttestationsForAgent(agent.agentId).some((a) => a.attestationId === r.attestation.attestationId)).toBe(true);
  });

  it("rejects a signature that doesn't match the verifier", async () => {
    const { agent } = makeAgent(["research"]);
    const verifier = testWallet();
    const wrongSigner = testWallet();
    // Signed by the wrong key for the claimed verifier.
    const sig = await wrongSigner.sign(attestationMessage(agent.agentId, "research"));
    const r = await createAttestation({ agentId: agent.agentId, capability: "research", verifier: verifier.address, signature: sig });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("SIGNATURE");
  });

  it("rejects an attestation for a capability the agent does not list", async () => {
    const { agent } = makeAgent(["research"]);
    const verifier = testWallet();
    const sig = await verifier.sign(attestationMessage(agent.agentId, "coding"));
    const r = await createAttestation({ agentId: agent.agentId, capability: "coding", verifier: verifier.address, signature: sig });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("rejects an unknown agent", async () => {
    const verifier = testWallet();
    const sig = await verifier.sign(attestationMessage("no-such-agent", "research"));
    const r = await createAttestation({ agentId: "no-such-agent", capability: "research", verifier: verifier.address, signature: sig });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });

  it("blocks self-attestation by the agent's own owner", async () => {
    const { agent, owner } = makeAgent(["research"]);
    // The owner signs with the agent's own wallet.
    const sig = await owner.sign(attestationMessage(agent.agentId, "research"));
    const r = await createAttestation({ agentId: agent.agentId, capability: "research", verifier: agent.walletAddress!, signature: sig });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("FORBIDDEN");
  });

  it("rejects a duplicate attestation from the same verifier", async () => {
    const { agent } = makeAgent(["research"]);
    const verifier = testWallet();
    const sig = await verifier.sign(attestationMessage(agent.agentId, "research"));
    await createAttestation({ agentId: agent.agentId, capability: "research", verifier: verifier.address, signature: sig });
    const dup = await createAttestation({ agentId: agent.agentId, capability: "research", verifier: verifier.address, signature: sig });
    expect(dup.success).toBe(false);
    if (!dup.success) expect(dup.code).toBe("DUPLICATE");
  });

  it("revokes an attestation with a valid verifier signature", async () => {
    const { agent } = makeAgent(["research"]);
    const verifier = testWallet();
    const created = await createAttestation({
      agentId: agent.agentId,
      capability: "research",
      verifier: verifier.address,
      signature: await verifier.sign(attestationMessage(agent.agentId, "research")),
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const revokeSig = await verifier.sign(revocationMessage(created.attestation.attestationId));
    const r = await revokeAttestation(created.attestation.attestationId, revokeSig);
    expect(r.success).toBe(true);
    expect(getAttestationsForAgent(agent.agentId).length).toBe(0);
  });

  it("rejects revocation with a non-verifier signature", async () => {
    const { agent } = makeAgent(["research"]);
    const verifier = testWallet();
    const created = await createAttestation({
      agentId: agent.agentId,
      capability: "research",
      verifier: verifier.address,
      signature: await verifier.sign(attestationMessage(agent.agentId, "research")),
    });
    if (!created.success) return;
    const attacker = testWallet();
    const r = await revokeAttestation(created.attestation.attestationId, await attacker.sign(revocationMessage(created.attestation.attestationId)));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("SIGNATURE");
  });

  it("rejects revoking an unknown attestation", async () => {
    const verifier = testWallet();
    const r = await revokeAttestation(randomUUID(), await verifier.sign(revocationMessage("x")));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });
});
