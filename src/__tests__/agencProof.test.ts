// Portable proof at the cross-network boundary — getAxonProofByPda maps AgenC
// on-chain PDAs (agent + listing addresses from the public feeds) to the Axon
// agent's cached Proof Score, so "Also on AgenC" cards can show verifiable
// reputation BEFORE a cross-network hire. Contracts: matches by either address,
// omits agents without a positive score, never throws on hostile input.

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { getAxonProofByPda } from "@/lib/integrations/agencProof";
import { GET as listingsGET } from "@/app/api/agenc/listings/route";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

let counter = 0;
const WALLET = "11111111111111111111111111111111";

function seedAgent(proofScore: number | null, tier: string | null): string {
  counter++;
  const agent: Agent = {
    agentId: `proof-map-agent-${counter}`,
    name: `Proof Map Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pk-proof-map-${counter}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(agent);
  getDb()
    .prepare("UPDATE agents SET proof_score = ?, proof_score_tier = ? WHERE agent_id = ?")
    .run(proofScore, tier, agent.agentId);
  return agent.agentId;
}

function seedListing(agentId: string, agentAddress: string | null, listingAddress: string | null) {
  getDb()
    .prepare(
      `INSERT INTO agenc_listings (agent_id, agenc_agent_id, listing_id, spec_hash, cluster, agent_address, listing_address, status)
       VALUES (?, ?, ?, ?, 'mainnet', ?, ?, 'live')`,
    )
    .run(agentId, `aid-${agentId}`, `lid-${agentId}`, `hash-${agentId}`, agentAddress, listingAddress);
}

describe("getAxonProofByPda", () => {
  it("maps BOTH the agent PDA and the listing PDA to the Axon agent's cached score", () => {
    const id = seedAgent(788, "Trusted");
    seedListing(id, "AgentPda1111111111111111111111111111111111A", "ListingPda111111111111111111111111111111111B");
    const map = getAxonProofByPda([
      "AgentPda1111111111111111111111111111111111A",
      "ListingPda111111111111111111111111111111111B",
    ]);
    expect(map.get("AgentPda1111111111111111111111111111111111A")).toEqual({
      agentId: id,
      proofScore: 788,
      proofScoreTier: "Trusted",
    });
    expect(map.get("ListingPda111111111111111111111111111111111B")?.agentId).toBe(id);
  });

  it("unknown PDAs simply have no entry — the card shows the honest empty state", () => {
    const map = getAxonProofByPda(["TotallyUnknownPda111111111111111111111111111"]);
    expect(map.size).toBe(0);
  });

  it("omits agents with no positive Proof Score (badge never shows proof that doesn't exist)", () => {
    const nullId = seedAgent(null, null);
    const zeroId = seedAgent(0, null);
    seedListing(nullId, "NullScorePda11111111111111111111111111111111", null);
    seedListing(zeroId, "ZeroScorePda11111111111111111111111111111111", null);
    const map = getAxonProofByPda([
      "NullScorePda11111111111111111111111111111111",
      "ZeroScorePda11111111111111111111111111111111",
    ]);
    expect(map.size).toBe(0);
  });

  it("never throws on hostile or degenerate input", () => {
    expect(getAxonProofByPda([]).size).toBe(0);
    const hostile = [
      "",
      "'; DROP TABLE agents; --",
      "x".repeat(4000), // oversized — dropped before SQL
      "normal-looking-pda",
    ];
    expect(() => getAxonProofByPda(hostile)).not.toThrow();
    expect(getAxonProofByPda(hostile).size).toBe(0);
    // the agents table survived the injection attempt
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM agents").get()).toBeTruthy();
  });

  it("fails SOFT on a DB error — the cross-network routes must keep serving", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    getDb().exec("ALTER TABLE agenc_listings RENAME TO agenc_listings_bk");
    try {
      // the query now throws ("no such table") — the map must come back empty,
      // never propagate and 500 the /api/agenc/listings + goods routes
      const map = getAxonProofByPda(["AnyPda1111111111111111111111111111111111111A"]);
      expect(map.size).toBe(0);
      expect(quiet).toHaveBeenCalled();
    } finally {
      getDb().exec("ALTER TABLE agenc_listings_bk RENAME TO agenc_listings");
      quiet.mockRestore();
    }
  });

  it("deduplicates input PDAs (a grid of cards can repeat the same provider)", () => {
    const id = seedAgent(650, "Proven");
    seedListing(id, "DupPda11111111111111111111111111111111111111", null);
    const map = getAxonProofByPda(Array.from({ length: 50 }, () => "DupPda11111111111111111111111111111111111111"));
    expect(map.get("DupPda11111111111111111111111111111111111111")?.proofScore).toBe(650);
  });
});

// The one seam nothing else covers: the route is where the AgenC feed meets the
// DB mapping. Stubbed feed + seeded mapping → the response must carry axonProof
// on the matched card and an explicit null on the unmatched one.
describe("GET /api/agenc/listings axonProof enrichment", () => {
  it("attaches the proof to matched providers and null to the rest", async () => {
    const id = seedAgent(742, "Trusted");
    seedListing(id, "FeedProviderPda1111111111111111111111111111", null);
    const feedItem = (n: number, provider: string) => ({
      id: `FeedListing${n}Pda11111111111111111111111111`,
      name: `Feed Service ${n}`,
      state: 0,
      providerAgent: provider,
      priceSol: "0.01",
      metadataState: "verified",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).includes("/listings/feed.json")
          ? new Response(JSON.stringify({ items: [feedItem(1, "FeedProviderPda1111111111111111111111111111"), feedItem(2, "UnknownProviderPda111111111111111111111111")] }), { status: 200 })
          : new Response(JSON.stringify({ items: [] }), { status: 200 }),
      ),
    );
    try {
      const res = await listingsGET(new NextRequest("http://localhost/api/agenc/listings", { method: "GET" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { listings: { name: string; axonProof: { agentId: string; proofScore: number } | null }[] };
      const matched = body.listings.find((l) => l.name === "Feed Service 1");
      const unmatched = body.listings.find((l) => l.name === "Feed Service 2");
      expect(matched?.axonProof).toEqual({ agentId: id, proofScore: 742, proofScoreTier: "Trusted" });
      expect(unmatched?.axonProof).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
