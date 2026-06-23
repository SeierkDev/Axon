import { describe, it, expect } from "vitest";
import { isOwnerVerified, getVerifiedOwners } from "@/lib/ownerVerification";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import type { Agent } from "@/sdk/types";

let n = 0;
function makeAgent(walletAddress?: string): string {
  n++;
  const id = `ov-agent-${n}`;
  const agent: Agent = {
    agentId: id,
    name: id,
    capabilities: ["test"],
    publicKey: `pk-${id}`,
    walletAddress,
    provider: "anthropic",
    createdAt: new Date().toISOString(),
  };
  createAgent(agent);
  return id;
}

describe("owner verification", () => {
  it("verifies an agent once its owner wallet has authenticated", () => {
    const wallet = "OWNER_VERIFY_WALLET_1";
    const id = makeAgent(wallet);
    expect(isOwnerVerified(id)).toBe(false); // wallet set, but no API key yet
    createApiKey(wallet); // owner signs the challenge -> mints a key
    expect(isOwnerVerified(id)).toBe(true);
  });

  it("never verifies an agent with no wallet", () => {
    expect(isOwnerVerified(makeAgent(undefined))).toBe(false);
  });

  it("returns false for an unknown agent", () => {
    expect(isOwnerVerified("does-not-exist")).toBe(false);
  });

  it("batches verification across many agents in one call", () => {
    const wa = "OWNER_VERIFY_BATCH_A";
    const a = makeAgent(wa);
    createApiKey(wa);
    const b = makeAgent("OWNER_VERIFY_BATCH_B_UNAUTHED"); // wallet, no key
    const c = makeAgent(undefined); // no wallet
    const set = getVerifiedOwners([a, b, c]);
    expect(set.has(a)).toBe(true);
    expect(set.has(b)).toBe(false);
    expect(set.has(c)).toBe(false);
  });

  it("handles an empty id list", () => {
    expect(getVerifiedOwners([]).size).toBe(0);
  });
});
