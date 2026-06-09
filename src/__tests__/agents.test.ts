import { describe, it, expect } from "vitest";
import {
  createAgent,
  getAgentById,
  agentExists,
  updateAgent,
  searchAgents,
  categoryFromCapabilities,
  getAllAgents,
  getAgentCounts,
} from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

// Global counter — never reset, keeps IDs unique across all tests in this file
let counter = 0;

// Minimal valid Solana address (base58, 32 chars)
const TEST_WALLET = "11111111111111111111111111111111";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `test-agent-${counter}`,
    name: `Test Agent ${counter}`,
    capabilities: ["research", "summarization"],
    publicKey: `pubkey${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── categoryFromCapabilities ──────────────────────────────────────────────────

describe("categoryFromCapabilities", () => {
  it("maps known capability keywords to categories", () => {
    expect(categoryFromCapabilities(["research"])).toBe("Research");
    expect(categoryFromCapabilities(["trading", "defi"])).toBe("Finance");
    expect(categoryFromCapabilities(["coding", "testing"])).toBe("Development");
    expect(categoryFromCapabilities(["writing", "content"])).toBe("Content");
  });

  it("returns General for unknown capabilities", () => {
    expect(categoryFromCapabilities(["unknown", "something"])).toBe("General");
    expect(categoryFromCapabilities([])).toBe("General");
  });

  it("is case-insensitive", () => {
    expect(categoryFromCapabilities(["RESEARCH"])).toBe("Research");
    expect(categoryFromCapabilities(["Trading"])).toBe("Finance");
  });
});

// ── createAgent / getAgentById ────────────────────────────────────────────────

describe("createAgent", () => {
  it("creates and retrieves an agent", () => {
    const agent = makeAgent();
    const created = createAgent(agent);
    expect(created.agentId).toBe(agent.agentId);
    expect(created.name).toBe(agent.name);
    expect(created.capabilities).toEqual(agent.capabilities);

    const fetched = getAgentById(agent.agentId);
    expect(fetched).not.toBeNull();
    expect(fetched!.agentId).toBe(agent.agentId);
  });

  it("returns null for unknown agent ID", () => {
    expect(getAgentById("does-not-exist")).toBeNull();
  });

  it("agentExists returns true only for existing agents", () => {
    const agent = makeAgent();
    createAgent(agent);
    expect(agentExists(agent.agentId)).toBe(true);
    expect(agentExists("nonexistent-id")).toBe(false);
  });

  it("throws on duplicate agent ID", () => {
    const agent = makeAgent();
    createAgent(agent);
    expect(() => createAgent(agent)).toThrow();
  });

  it("stores an explicitly provided category", () => {
    const agent = makeAgent({ capabilities: ["coding", "debugging"], category: "Development" });
    const created = createAgent({ ...agent, agentId: `${agent.agentId}-cat` });
    expect(created.category).toBe("Development");
  });
});

// ── updateAgent ───────────────────────────────────────────────────────────────

describe("updateAgent", () => {
  it("updates agent name", () => {
    const agent = makeAgent();
    createAgent(agent);
    const updated = updateAgent(agent.agentId, { name: "New Name" });
    expect(updated!.name).toBe("New Name");
    expect(getAgentById(agent.agentId)!.name).toBe("New Name");
  });

  it("updates capabilities and recalculates category", () => {
    const agent = makeAgent({ capabilities: ["research"] });
    createAgent(agent);
    const updated = updateAgent(agent.agentId, { capabilities: ["coding", "testing"] });
    expect(updated!.capabilities).toEqual(["coding", "testing"]);
    expect(updated!.category).toBe("Development");
  });

  it("setting endpoint resets verification_status to unverified", () => {
    const agent = makeAgent();
    createAgent(agent);
    getDb().prepare("UPDATE agents SET verification_status = 'x402_compliant' WHERE agent_id = ?").run(agent.agentId);

    const updated = updateAgent(agent.agentId, { endpoint: "https://new-endpoint.com" });
    expect(updated!.verificationStatus).toBe("unverified");
  });

  it("clearing endpoint also resets verification_status", () => {
    const agent = makeAgent({ endpoint: "https://example.com/agent" });
    createAgent(agent);
    getDb().prepare("UPDATE agents SET verification_status = 'reachable' WHERE agent_id = ?").run(agent.agentId);

    const updated = updateAgent(agent.agentId, { endpoint: null });
    expect(updated!.endpoint).toBeUndefined();
    expect(updated!.verificationStatus).toBe("unverified");
  });

  it("returns null for non-existent agent", () => {
    const result = updateAgent("nonexistent-999", { name: "test" });
    expect(result).toBeNull();
  });
});

// ── searchAgents ──────────────────────────────────────────────────────────────

describe("searchAgents", () => {
  const PREFIX = "search";

  it("returns agents matching a single capability", () => {
    createAgent(makeAgent({ agentId: `${PREFIX}-a1`, capabilities: ["research", "analysis"], reputation: 8 }));
    createAgent(makeAgent({ agentId: `${PREFIX}-a2`, capabilities: ["coding", "testing"], reputation: 5 }));
    createAgent(makeAgent({ agentId: `${PREFIX}-a3`, capabilities: ["research", "coding"], reputation: 3 }));

    const results = searchAgents({ capability: "research", limit: 20 });
    const ids = results.map((a) => a.agentId);
    expect(ids).toContain(`${PREFIX}-a1`);
    expect(ids).toContain(`${PREFIX}-a3`);
    expect(ids).not.toContain(`${PREFIX}-a2`);
  });

  it("returns agents matching ALL capabilities (AND semantics)", () => {
    const results = searchAgents({ capabilities: ["research", "coding"], limit: 20 });
    const ids = results.map((a) => a.agentId);
    expect(ids).toContain(`${PREFIX}-a3`);
    expect(ids).not.toContain(`${PREFIX}-a1`);
    expect(ids).not.toContain(`${PREFIX}-a2`);
  });

  it("respects minReputation filter", () => {
    const results = searchAgents({ minReputation: 6, limit: 20 });
    const ids = results.map((a) => a.agentId);
    expect(ids).toContain(`${PREFIX}-a1`);
    expect(ids).not.toContain(`${PREFIX}-a2`);
    expect(ids).not.toContain(`${PREFIX}-a3`);
  });

  it("respects limit", () => {
    const results = searchAgents({ limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// ── searchAgents: category filter ─────────────────────────────────────────────

describe("searchAgents: category filter", () => {
  const PREFIX = "cat";

  it("filters agents by an exact category", () => {
    createAgent(makeAgent({ agentId: `${PREFIX}-1`, category: "Finance", capabilities: ["trading"] }));
    createAgent(makeAgent({ agentId: `${PREFIX}-2`, category: "Research", capabilities: ["research"] }));

    const results = searchAgents({ category: "Finance", limit: 50 });
    const ids = results.map((a) => a.agentId);
    expect(ids).toContain(`${PREFIX}-1`);
    expect(ids).not.toContain(`${PREFIX}-2`);
  });

  it("returns all agents when category is 'All'", () => {
    const results = searchAgents({ category: "All", limit: 50 });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});

// ── searchAgents: maxPrice filter ─────────────────────────────────────────────

describe("searchAgents: maxPrice filter", () => {
  const PREFIX = "maxp";

  it("includes free agents and paid agents at or below maxPrice; excludes those above", () => {
    createAgent(makeAgent({ agentId: `${PREFIX}-cheap`, price: "0.5 USDC", capabilities: ["coding"] }));
    createAgent(makeAgent({ agentId: `${PREFIX}-expensive`, price: "1.5 USDC", capabilities: ["coding"] }));
    createAgent(makeAgent({ agentId: `${PREFIX}-free`, capabilities: ["coding"] }));

    const results = searchAgents({ maxPrice: "1 USDC", limit: 50 });
    const ids = results.map((a) => a.agentId);
    expect(ids).toContain(`${PREFIX}-cheap`);
    expect(ids).toContain(`${PREFIX}-free`);
    expect(ids).not.toContain(`${PREFIX}-expensive`);
  });
});

// ── searchAgents: price sort ──────────────────────────────────────────────────

describe("searchAgents: price sort", () => {
  const PREFIX = "psort";

  it("sorts free agents before paid agents", () => {
    createAgent(makeAgent({ agentId: `${PREFIX}-free`, capabilities: ["analysis"] }));
    createAgent(makeAgent({ agentId: `${PREFIX}-paid`, price: "2 USDC", capabilities: ["analysis"] }));

    const results = searchAgents({ sort: "price", limit: 50 });
    const ids = results.map((a) => a.agentId);
    const freeIdx = ids.indexOf(`${PREFIX}-free`);
    const paidIdx = ids.indexOf(`${PREFIX}-paid`);
    expect(freeIdx).toBeGreaterThanOrEqual(0);
    expect(paidIdx).toBeGreaterThanOrEqual(0);
    expect(freeIdx).toBeLessThan(paidIdx);
  });
});

// ── getAllAgents ──────────────────────────────────────────────────────────────

describe("getAllAgents", () => {
  it("returns all registered agents and grows when a new one is added", () => {
    const before = getAllAgents().length;
    createAgent(makeAgent({ agentId: "all-agents-extra" }));
    const after = getAllAgents();
    expect(after.length).toBe(before + 1);
  });

  it("returns agents with correct shape", () => {
    const agents = getAllAgents();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].agentId).toBeDefined();
    expect(agents[0].name).toBeDefined();
    expect(Array.isArray(agents[0].capabilities)).toBe(true);
  });
});

// ── getAgentCounts ────────────────────────────────────────────────────────────

describe("getAgentCounts", () => {
  it("returns counts with correct numeric structure", () => {
    const counts = getAgentCounts();
    expect(typeof counts.total).toBe("number");
    expect(typeof counts.paid).toBe("number");
    expect(typeof counts.categories).toBe("number");
    expect(typeof counts.active).toBe("number");
    expect(counts.total).toBeGreaterThanOrEqual(0);
  });

  it("increments total and paid when a priced agent is added", () => {
    const before = getAgentCounts();
    createAgent(makeAgent({ agentId: "count-paid-agent", price: "1 USDC" }));
    const after = getAgentCounts();
    expect(after.total).toBe(before.total + 1);
    expect(after.paid).toBe(before.paid + 1);
  });
});

// ── parseCapabilitiesJson: catch path ─────────────────────────────────────────

describe("parseCapabilitiesJson catch path", () => {
  it("returns empty capabilities array when DB row has malformed JSON", () => {
    const agent = makeAgent({ agentId: "badcaps-agent" });
    createAgent(agent);
    getDb()
      .prepare("UPDATE agents SET capabilities = 'bad-json' WHERE agent_id = ?")
      .run(agent.agentId);
    const fetched = getAgentById(agent.agentId)!;
    expect(fetched).not.toBeNull();
    expect(fetched.capabilities).toEqual([]);
  });
});

// ── updateAgent: price field ──────────────────────────────────────────────────

describe("updateAgent: price", () => {
  it("sets a price on an agent that had none", () => {
    const agent = makeAgent({ agentId: "price-update-agent" });
    createAgent(agent);
    const updated = updateAgent(agent.agentId, { price: "2 USDC" });
    expect(updated).not.toBeNull();
    expect(updated!.price).toBe("2 USDC");
  });
});

// ── searchAgents price sort: mixed currencies ─────────────────────────────────

// ── searchAgents: maxPrice filter edge cases ──────────────────────────────────

describe("searchAgents: maxPrice filter with unparseable and cross-currency prices", () => {
  const PREFIX = "maxpe";

  it("excludes an agent with a malformed (unparseable) price string", () => {
    createAgent(makeAgent({ agentId: `${PREFIX}-malformed`, price: "not-a-price", capabilities: ["archive"] }));
    const results = searchAgents({ maxPrice: "1 USDC", capability: "archive", limit: 50 });
    const ids = results.map((a) => a.agentId);
    expect(ids).not.toContain(`${PREFIX}-malformed`);
  });

  it("excludes a SOL-priced agent when maxPrice is in USDC (currency mismatch)", () => {
    createAgent(makeAgent({ agentId: `${PREFIX}-sol`, price: "0.001 SOL", capabilities: ["archive"] }));
    const results = searchAgents({ maxPrice: "1 USDC", capability: "archive", limit: 50 });
    const ids = results.map((a) => a.agentId);
    expect(ids).not.toContain(`${PREFIX}-sol`);
  });
});

describe("searchAgents: price sort with mixed currencies", () => {
  const PREFIX = "mixcur";

  it("sorts SOL-priced agents before USDC-priced agents (localeCompare)", () => {
    createAgent(makeAgent({ agentId: `${PREFIX}-sol`, price: "0.001 SOL", capabilities: ["translate"] }));
    createAgent(makeAgent({ agentId: `${PREFIX}-usdc`, price: "1 USDC", capabilities: ["translate"] }));

    const results = searchAgents({ capability: "translate", sort: "price", limit: 50 });
    const ids = results.map((a) => a.agentId);
    const solIdx = ids.indexOf(`${PREFIX}-sol`);
    const usdcIdx = ids.indexOf(`${PREFIX}-usdc`);
    expect(solIdx).toBeGreaterThanOrEqual(0);
    expect(usdcIdx).toBeGreaterThanOrEqual(0);
    // "SOL".localeCompare("USDC") < 0, so SOL comes before USDC
    expect(solIdx).toBeLessThan(usdcIdx);
  });
});

// ── searchAgents: price sort — both free (sort by reputation) ─────────────────

describe("searchAgents: price sort — two free agents sorted by reputation", () => {
  const PREFIX = "freesort";

  it("uses reputation as tiebreaker when both agents have no price", () => {
    createAgent(makeAgent({ agentId: `${PREFIX}-low`, capabilities: ["vision"], reputation: 1 }));
    createAgent(makeAgent({ agentId: `${PREFIX}-high`, capabilities: ["vision"], reputation: 9 }));

    const results = searchAgents({ capability: "vision", sort: "price", limit: 50 });
    const ids = results.map((a) => a.agentId);
    const lowIdx = ids.indexOf(`${PREFIX}-low`);
    const highIdx = ids.indexOf(`${PREFIX}-high`);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeGreaterThanOrEqual(0);
    // Higher reputation should come first when both are free
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ── searchAgents: no capability filter (null agentIds → SELECT * FROM agents) ──

describe("searchAgents: no capability filter uses direct agents table scan", () => {
  const PREFIX = "noscan";

  it("returns agents when no capability filter is given (null agentIds path)", () => {
    createAgent(makeAgent({ agentId: `${PREFIX}-a`, capabilities: ["storage"] }));
    createAgent(makeAgent({ agentId: `${PREFIX}-b`, capabilities: ["storage"] }));

    // No capability/capabilities filter → agentIds is null → SELECT * FROM agents
    const results = searchAgents({ sort: "price", limit: 50 });
    const ids = results.map((a) => a.agentId);
    expect(ids).toContain(`${PREFIX}-a`);
    expect(ids).toContain(`${PREFIX}-b`);
  });
});
