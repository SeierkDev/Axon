// Cross-network discovery: normalizing AgenC's public listing feed for the Axon
// marketplace. Contracts — only active+named listings, deduped, real services
// ranked above test/e2e; the provider agent's reputation joined in (best-effort);
// and NEVER throws (feed outage → [], reputation outage → cards without rep).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Route mock fetch by URL: the AgenC listing feed vs the agents API.
function mockAgenc(listings: unknown[], agents: unknown[] = []) {
  global.fetch = vi.fn().mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes("/api/agents")) return Promise.resolve({ ok: true, json: async () => ({ items: agents }) });
    return Promise.resolve({ ok: true, json: async () => ({ items: listings }) });
  }) as unknown as typeof fetch;
}

describe("getAgencListings", () => {
  beforeEach(() => vi.resetModules()); // fresh module = fresh in-memory cache each test

  it("keeps only active+named, dedupes by name, ranks real services over e2e, drops the rest", async () => {
    mockAgenc([
      { id: "1", name: "Real Service", state: 0, metadataState: "verified", category: "research", tags: ["research"], priceSol: "0.1", openJobs: 3 },
      { id: "2", name: "Real Service", state: 0, metadataState: "verified", priceSol: "0.1" }, // duplicate name
      { id: "3", name: "AgenC Store Flow E2E", state: 0, metadataState: "verified", tags: ["e2e"], priceSol: "0.001" }, // test-like → ranked last
      { id: "4", name: "Inactive", state: 1, metadataState: "verified" }, // dropped: not active
      { id: "5", name: "  ", state: 0 }, // dropped: no name
    ]);
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    const out = await getAgencListings();
    expect(out.map((l) => l.name)).toEqual(["Real Service", "AgenC Store Flow E2E"]);
    expect(out[0]).toMatchObject({ category: "research", verified: true, url: expect.stringContaining("agenc.ag") });
  });

  it("joins the provider agent's AgenC reputation (0-10) + tasks by providerAgent", async () => {
    mockAgenc(
      [{ id: "1", name: "Svc", state: 0, metadataState: "verified", providerAgent: "AGENT_PDA", priceSol: "0.1" }],
      [{ pda: "AGENT_PDA", reputation: 7700, tasksCompleted: 42 }],
    );
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    const out = await getAgencListings();
    expect(out[0].reputation).toBe(7.7); // 7700 / 1000
    expect(out[0].tasksCompleted).toBe(42);
  });

  it("leaves reputation null when the provider isn't in the agents API", async () => {
    mockAgenc([{ id: "1", name: "Svc", state: 0, metadataState: "verified", providerAgent: "UNKNOWN", priceSol: "0.1" }], []);
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    expect((await getAgencListings())[0].reputation).toBeNull();
  });

  it("still renders listings when the reputation API fails (reputation is optional)", async () => {
    global.fetch = vi.fn().mockImplementation((url: unknown) => {
      if (String(url).includes("/api/agents")) return Promise.reject(new Error("agents down"));
      return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: "1", name: "Svc", state: 0, metadataState: "verified", providerAgent: "x", priceSol: "0.1" }] }) });
    }) as unknown as typeof fetch;
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    const out = await getAgencListings();
    expect(out).toHaveLength(1);
    expect(out[0].reputation).toBeNull();
  });

  it("always builds the canonical listing URL, ignoring any feed-supplied href (no phishing redirect)", async () => {
    mockAgenc([{ id: "abc", name: "Evil", state: 0, metadataState: "verified", url: "https://phishing.example/steal" }]);
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    expect((await getAgencListings())[0].url).toBe("https://agenc.ag/listings/abc");
  });

  it("survives a malformed row (non-string name/description) without dropping the whole batch", async () => {
    mockAgenc([
      { id: "1", name: 12345, state: 0, metadataState: "verified" }, // numeric name — must not throw
      { id: 42, name: "NumId", state: 0, metadataState: "verified" }, // numeric id → dropped (no empty key / dead URL)
      { id: "2", name: "Good", description: 999, state: 0, metadataState: "verified", priceSol: "0.1" }, // numeric description
    ]);
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    const out = await getAgencListings();
    expect(out.map((l) => l.name)).toEqual(["Good"]); // bad rows dropped, good row survives
    expect(out[0].description).toBeNull();
    expect(out.every((l) => l.id && l.url !== "https://agenc.ag/listings/")).toBe(true); // no empty id / dead url
  });

  it("dedupes AFTER ranking, keeping the verified duplicate over an earlier unverified one", async () => {
    mockAgenc([
      { id: "1", name: "Twin", state: 0, priceSol: "0.1" }, // unverified, comes first in the feed
      { id: "2", name: "Twin", state: 0, metadataState: "verified", category: "research", priceSol: "0.1" }, // verified
    ]);
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    const out = await getAgencListings();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ verified: true, category: "research" }); // kept the better one
  });

  it("fails soft to [] when the listing feed is unreachable (never breaks the marketplace)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    expect(await getAgencListings()).toEqual([]);
  });

  it("coalesces concurrent cache-miss calls into a single feed refresh", async () => {
    let feedCalls = 0;
    global.fetch = vi.fn().mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/agents")) return { ok: true, json: async () => ({ items: [] }) };
      feedCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, json: async () => ({ items: [{ id: "1", name: "A", state: 0, metadataState: "verified" }] }) };
    }) as unknown as typeof fetch;
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    const [a, b] = await Promise.all([getAgencListings(), getAgencListings()]);
    expect(feedCalls).toBe(1); // two concurrent callers, one refresh
    expect(a).toEqual(b);
  });

  it("fails soft on a non-200 feed response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    const { getAgencListings } = await import("@/lib/integrations/agencDiscovery");
    expect(await getAgencListings()).toEqual([]);
  });
});
