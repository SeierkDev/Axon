import { describe, it, expect } from "vitest";
import { createAgent } from "@/lib/agents";
import {
  crossListAgent,
  getAgencListing,
  getAgencListedIds,
  deriveAgencAgentId,
  deriveAgencListingId,
  priceToAgencUnits,
  toFixedBytes,
  agentServiceSpec,
} from "@/lib/integrations/agencListing";
import { agencJobSpecHash } from "@/lib/integrations/agenc";
import type { Agent } from "@/sdk/types";

let counter = 0;
const TEST_WALLET = "11111111111111111111111111111111";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `agenc-list-agent-${counter}`,
    name: `Cross List ${counter}`,
    capabilities: ["research"],
    publicKey: `pubkey-agenc-${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    price: "0.25 USDC",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("AgenC cross-listing derivations", () => {
  it("derives deterministic 32-byte ids namespaced per agent", () => {
    const a = deriveAgencAgentId("agent-1");
    expect(a).toBe(deriveAgencAgentId("agent-1")); // stable
    expect(a).not.toBe(deriveAgencListingId("agent-1")); // namespaced
    expect(a).not.toBe(deriveAgencAgentId("agent-2"));
    expect(Buffer.from(a, "hex")).toHaveLength(32);
  });

  it("converts Axon prices to AgenC 6-decimal units", () => {
    expect(priceToAgencUnits("0.25 USDC")).toBe(250_000n);
    expect(priceToAgencUnits("2 USDC")).toBe(2_000_000n);
    expect(priceToAgencUnits("1.5")).toBe(1_500_000n);
    expect(priceToAgencUnits(null)).toBe(0n);
    expect(priceToAgencUnits("free")).toBe(0n);
  });

  it("pads/truncates fixed byte fields", () => {
    expect(toFixedBytes("axon", 32)).toHaveLength(32);
    expect(toFixedBytes("x".repeat(100), 32)).toHaveLength(32);
  });

  it("service spec hash is AgenC-canonical and price-sensitive", () => {
    const agent = makeAgent();
    const hash = agencJobSpecHash(agentServiceSpec(agent));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const repriced = agencJobSpecHash(agentServiceSpec({ ...agent, price: "9.99 USDC" }));
    expect(repriced).not.toBe(hash);
  });
});

describe("crossListAgent", () => {
  it("executes the listing flow against AgenC's program and records the PDAs", async () => {
    const agent = makeAgent();
    createAgent(agent);
    const listing = await crossListAgent(agent);

    expect(listing.agentId).toBe(agent.agentId);
    expect(listing.agencAgentId).toBe(deriveAgencAgentId(agent.agentId));
    expect(listing.listingId).toBe(deriveAgencListingId(agent.agentId));
    expect(listing.specHash).toBe(agencJobSpecHash(agentServiceSpec(agent)));
    // In the test environment litesvm is available, so the full register →
    // list → attest flow ran against AgenC's real compiled program.
    expect(listing.status).toBe("verified-sandbox");
    expect(listing.agentAddress).toBeTruthy();
    expect(listing.listingAddress).toBeTruthy();

    // Round-trips + batched badge lookup.
    expect(getAgencListing(agent.agentId)?.listingAddress).toBe(listing.listingAddress);
    const ids = getAgencListedIds([agent.agentId, "not-listed"]);
    expect(ids.has(agent.agentId)).toBe(true);
    expect(ids.has("not-listed")).toBe(false);
  }, 30_000);

  it("is idempotent — relisting upserts the same derived identity", async () => {
    const agent = makeAgent();
    createAgent(agent);
    const first = await crossListAgent(agent);
    const second = await crossListAgent(agent);
    expect(second.agencAgentId).toBe(first.agencAgentId);
    expect(second.listingId).toBe(first.listingId);
  }, 30_000);
});
