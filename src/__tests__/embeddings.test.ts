import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  buildAgentEmbeddingText,
  generateEmbedding,
  storeAgentEmbedding,
  getAgentEmbedding,
  semanticSearchAgents,
} from "@/lib/embeddings";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";

const WALLET = "11111111111111111111111111111111";
let seq = 0;
function uid() { return `emb-${++seq}`; }

// Unit vector with 1.0 at position `pos`, 0 elsewhere — 1536 dims (OpenAI small)
function unitVec(pos: number): number[] {
  const v = new Array(1536).fill(0);
  v[pos] = 1;
  return v;
}

function fakeOkFetch(embedding: number[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: [{ embedding, index: 0 }] }),
    text: () => Promise.resolve(""),
  });
}

function makeAgent(id: string, opts: {
  reputation?: number;
  category?: string;
  price?: string;
  capabilities?: string[];
} = {}) {
  return createAgent({
    agentId: id,
    name: `Agent ${id}`,
    capabilities: opts.capabilities ?? ["default"],
    publicKey: `pk-${id}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: opts.reputation ?? 0,
    category: opts.category,
    price: opts.price,
    createdAt: new Date().toISOString(),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

// ── buildAgentEmbeddingText ───────────────────────────────────────────────────

describe("buildAgentEmbeddingText", () => {
  it("includes name, capabilities, and category", () => {
    const text = buildAgentEmbeddingText({
      name: "My Agent",
      capabilities: ["search", "summarize"],
      category: "Research",
    });
    expect(text).toContain("My Agent");
    expect(text).toContain("search, summarize");
    expect(text).toContain("category: Research");
  });

  it("omits the category clause when category is not provided", () => {
    const text = buildAgentEmbeddingText({
      name: "My Agent",
      capabilities: ["search"],
    });
    expect(text).not.toContain("category:");
    expect(text).toContain("My Agent");
    expect(text).toContain("search");
  });

  it("truncates to at most 500 characters", () => {
    const text = buildAgentEmbeddingText({
      name: "n".repeat(600),
      capabilities: ["cap"],
      category: "Cat",
    });
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it("handles an empty capabilities array", () => {
    const text = buildAgentEmbeddingText({ name: "Agent", capabilities: [] });
    expect(text).toContain("Agent");
    expect(text).toContain("capabilities:");
  });
});

// ── generateEmbedding ────────────────────────────────────────────────────────

describe("generateEmbedding", () => {
  it("returns null when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("returns the embedding array from the API on success", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const expected = unitVec(0);
    vi.stubGlobal("fetch", fakeOkFetch(expected));
    expect(await generateEmbedding("hello")).toEqual(expected);
  });

  it("returns null on a non-ok HTTP response", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("unauthorized"),
    }));
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("returns null when the embedding has wrong dimensions", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch([0.1, 0.2, 0.3])); // 3 dims, not 1536
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("returns null when fetch throws a network error", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("returns null when the response body has no data array", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }), // empty
      text: () => Promise.resolve(""),
    }));
    expect(await generateEmbedding("hello")).toBeNull();
  });
});

// ── storeAgentEmbedding / getAgentEmbedding ──────────────────────────────────

describe("storeAgentEmbedding / getAgentEmbedding", () => {
  it("round-trips an embedding", () => {
    const id = uid(); makeAgent(id);
    const vec = unitVec(7);
    storeAgentEmbedding(id, vec);
    expect(getAgentEmbedding(id)).toEqual(vec);
  });

  it("returns null for an agent that does not exist", () => {
    expect(getAgentEmbedding("ghost-xyz-999")).toBeNull();
  });

  it("returns null for an agent with no embedding stored", () => {
    const id = uid(); makeAgent(id);
    expect(getAgentEmbedding(id)).toBeNull();
  });

  it("overwrites a previously stored embedding", () => {
    const id = uid(); makeAgent(id);
    storeAgentEmbedding(id, unitVec(0));
    storeAgentEmbedding(id, unitVec(5));
    expect(getAgentEmbedding(id)![5]).toBe(1);
    expect(getAgentEmbedding(id)![0]).toBe(0);
  });

  it("returns null when the stored embedding is invalid JSON", () => {
    const id = uid(); makeAgent(id);
    getDb().prepare("UPDATE agents SET embedding = ? WHERE agent_id = ?").run("{{not-json}}", id);
    expect(getAgentEmbedding(id)).toBeNull();
  });
});

// ── semanticSearchAgents ─────────────────────────────────────────────────────

describe("semanticSearchAgents", () => {
  // Each test here needs a clean embedding slate — earlier tests in this file
  // create agents with stored embeddings, which would otherwise pollute results.
  beforeEach(() => {
    getDb().prepare("UPDATE agents SET embedding = NULL").run();
  });
  it("returns null when generateEmbedding returns null (no API key)", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await semanticSearchAgents("query", { q: "query" })).toBeNull();
  });

  it("returns empty array when no agents have embeddings stored", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));
    // No agents registered in this test — DB starts empty per test file
    const results = await semanticSearchAgents("query", { q: "query" });
    expect(results).toEqual([]);
  });

  it("ranks agents by cosine similarity — most similar agent listed first", async () => {
    // Agents are created without API key so scheduleAgentEmbedding is a no-op
    const id1 = uid(); makeAgent(id1); storeAgentEmbedding(id1, unitVec(0)); // aligns with query
    const id2 = uid(); makeAgent(id2); storeAgentEmbedding(id2, unitVec(1)); // orthogonal
    const id3 = uid(); makeAgent(id3); storeAgentEmbedding(id3, unitVec(2)); // orthogonal

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0))); // query vector points at dim 0

    const results = await semanticSearchAgents("find agent", { q: "find agent", limit: 100 });
    expect(results).not.toBeNull();
    expect(results![0].agentId).toBe(id1); // id1 has cosine=1, others have cosine=0
  });

  it("filters by capability (AND — agent must have it)", async () => {
    const idHas = uid(); makeAgent(idHas, { capabilities: ["search", "summarize"] });
    const idMissing = uid(); makeAgent(idMissing, { capabilities: ["coding"] });
    storeAgentEmbedding(idHas, unitVec(0));
    storeAgentEmbedding(idMissing, unitVec(0)); // same similarity

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", { q: "test", capability: "search", limit: 100 });
    expect(results).not.toBeNull();
    const ids = results!.map((r) => r.agentId);
    expect(ids).toContain(idHas);
    expect(ids).not.toContain(idMissing);
  });

  it("filters by multiple capabilities (AND — all must be present)", async () => {
    const idBoth = uid(); makeAgent(idBoth, { capabilities: ["search", "summarize"] });
    const idOne  = uid(); makeAgent(idOne, { capabilities: ["search"] }); // missing summarize
    storeAgentEmbedding(idBoth, unitVec(0));
    storeAgentEmbedding(idOne, unitVec(0));

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", {
      q: "test",
      capabilities: ["search", "summarize"],
      limit: 100,
    });
    expect(results).not.toBeNull();
    const ids = results!.map((r) => r.agentId);
    expect(ids).toContain(idBoth);
    expect(ids).not.toContain(idOne);
  });

  it("filters by minReputation", async () => {
    const idHigh = uid(); makeAgent(idHigh, { reputation: 8 });
    const idLow  = uid(); makeAgent(idLow, { reputation: 2 });
    storeAgentEmbedding(idHigh, unitVec(0));
    storeAgentEmbedding(idLow, unitVec(0));

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", { q: "test", minReputation: 5, limit: 100 });
    expect(results).not.toBeNull();
    const ids = results!.map((r) => r.agentId);
    expect(ids).toContain(idHigh);
    expect(ids).not.toContain(idLow);
  });

  it("filters by category", async () => {
    const idResearch = uid(); makeAgent(idResearch, { category: "Research" });
    const idTrading  = uid(); makeAgent(idTrading, { category: "Finance" });
    storeAgentEmbedding(idResearch, unitVec(0));
    storeAgentEmbedding(idTrading, unitVec(0));

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", { q: "test", category: "Research", limit: 100 });
    expect(results).not.toBeNull();
    const ids = results!.map((r) => r.agentId);
    expect(ids).toContain(idResearch);
    expect(ids).not.toContain(idTrading);
  });

  it("filters by maxPrice — excludes agents whose price exceeds the cap", async () => {
    const idFree      = uid(); makeAgent(idFree);
    const idCheap     = uid(); makeAgent(idCheap, { price: "0.05 USDC" });
    const idExpensive = uid(); makeAgent(idExpensive, { price: "1.00 USDC" });
    storeAgentEmbedding(idFree, unitVec(0));
    storeAgentEmbedding(idCheap, unitVec(0));
    storeAgentEmbedding(idExpensive, unitVec(0));

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", { q: "test", maxPrice: "0.10 USDC", limit: 100 });
    expect(results).not.toBeNull();
    const ids = results!.map((r) => r.agentId);
    expect(ids).toContain(idFree);
    expect(ids).toContain(idCheap);
    expect(ids).not.toContain(idExpensive);
  });

  it("respects the limit option", async () => {
    const ids = Array.from({ length: 6 }, () => {
      const id = uid(); makeAgent(id); storeAgentEmbedding(id, unitVec(0)); return id;
    });
    void ids; // used indirectly via DB

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", { q: "test", limit: 3 });
    expect(results).not.toBeNull();
    expect(results!.length).toBeLessThanOrEqual(3);
  });

  it("silently skips agents whose stored embedding is invalid JSON", async () => {
    const idGood = uid(); makeAgent(idGood); storeAgentEmbedding(idGood, unitVec(0));
    const idBad  = uid(); makeAgent(idBad);
    getDb().prepare("UPDATE agents SET embedding = ? WHERE agent_id = ?").run("{{bad}}", idBad);

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", { q: "test", limit: 100 });
    expect(results).not.toBeNull();
    const ids = results!.map((r) => r.agentId);
    expect(ids).toContain(idGood);
    expect(ids).not.toContain(idBad);
  });

  it("excludes agents with malformed capabilities JSON when filtering by capability", async () => {
    const idGood    = uid(); makeAgent(idGood, { capabilities: ["search"] }); storeAgentEmbedding(idGood, unitVec(0));
    const idBadCaps = uid(); makeAgent(idBadCaps); storeAgentEmbedding(idBadCaps, unitVec(0));
    getDb().prepare("UPDATE agents SET capabilities = ? WHERE agent_id = ?").run("{{bad}}", idBadCaps);

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", { q: "test", capability: "search", limit: 100 });
    expect(results).not.toBeNull();
    const ids = results!.map((r) => r.agentId);
    expect(ids).toContain(idGood);
    expect(ids).not.toContain(idBadCaps);
  });

  it("returns zero similarity without crashing when query embedding is a zero vector", async () => {
    const id = uid(); makeAgent(id); storeAgentEmbedding(id, unitVec(0));

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(new Array(1536).fill(0))); // zero vector → denom=0 guard

    const results = await semanticSearchAgents("test", { q: "test", limit: 100 });
    expect(results).not.toBeNull();
    // Agent still returned; similarity is 0 but no crash or division by zero
    expect(results!.some((r) => r.agentId === id)).toBe(true);
  });

  it("uses fallback values for null agent fields in rowToAgent", async () => {
    // Insert an agent with NULL category, provider, verificationStatus to exercise ?? fallbacks
    const id = uid();
    getDb().prepare(
      "INSERT INTO agents (agent_id, name, capabilities, public_key, reputation, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, `Agent ${id}`, '["test"]', `pk-${id}`, 0, new Date().toISOString());
    storeAgentEmbedding(id, unitVec(0));

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", { q: "test", limit: 100 });
    expect(results).not.toBeNull();
    const agent = results!.find((r) => r.agentId === id);
    expect(agent).toBeDefined();
    expect(agent!.category).toBe("General");
    expect(agent!.provider).toBe("anthropic");
    expect(agent!.verificationStatus).toBe("unverified");
  });

  it("combines capability and minReputation filters correctly", async () => {
    // Only this agent passes both: has the capability AND has high rep
    const idPass = uid(); makeAgent(idPass, { capabilities: ["ml"], reputation: 7 });
    const idWrongCap = uid(); makeAgent(idWrongCap, { capabilities: ["chat"], reputation: 9 });
    const idLowRep   = uid(); makeAgent(idLowRep, { capabilities: ["ml"], reputation: 1 });
    storeAgentEmbedding(idPass, unitVec(0));
    storeAgentEmbedding(idWrongCap, unitVec(0));
    storeAgentEmbedding(idLowRep, unitVec(0));

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fakeOkFetch(unitVec(0)));

    const results = await semanticSearchAgents("test", {
      q: "test",
      capability: "ml",
      minReputation: 5,
      limit: 100,
    });
    expect(results).not.toBeNull();
    const ids = results!.map((r) => r.agentId);
    expect(ids).toContain(idPass);
    expect(ids).not.toContain(idWrongCap);
    expect(ids).not.toContain(idLowRep);
  });
});
