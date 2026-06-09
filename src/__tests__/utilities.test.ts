import { describe, it, expect } from "vitest";
import { getAllCapabilities, getAgentIdsByCapability } from "@/lib/capabilities";
import { formatContext } from "@/lib/formatContext";
import { recordAuditEvent, getAuditEventById, listAuditEvents } from "@/lib/audit";
import { recommendPaymentPath } from "@/lib/paymentPath";
import { recordTaskLatency, getAgentMetrics } from "@/lib/metrics";
import { getNetworkStats, getDailyStats, getAllTimeLeaders } from "@/lib/analytics";
import { validateIdempotencyKey, hashIdempotencyPayload } from "@/lib/idempotency";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { NextRequest } from "next/server";

const TEST_WALLET = "11111111111111111111111111111111";
let counter = 0;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `util-${counter}`,
    name: `Util Agent ${counter}`,
    capabilities: [`cap-util-${counter}`],
    publicKey: `pk${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    headers: { "x-forwarded-for": "10.0.0.1" },
  });
}

// ── formatContext ─────────────────────────────────────────────────────────────

describe("formatContext", () => {
  it("returns empty string for undefined", () => {
    expect(formatContext(undefined)).toBe("");
  });

  it("returns empty string for empty object", () => {
    expect(formatContext({})).toBe("");
  });

  it("returns empty string when all values are null/undefined/empty", () => {
    expect(formatContext({ a: null, b: undefined, c: "" })).toBe("");
  });

  it("formats string values as key: value", () => {
    const result = formatContext({ task: "summarise" });
    expect(result).toContain("task: summarise");
    expect(result).toContain("Context:");
  });

  it("JSON-encodes object values", () => {
    const result = formatContext({ meta: { x: 1 } });
    expect(result).toContain('"x":1');
  });

  it("formats number values as strings", () => {
    const result = formatContext({ count: 42 });
    expect(result).toContain("count: 42");
  });

  it("includes multiple keys", () => {
    const result = formatContext({ a: "1", b: "2" });
    expect(result).toContain("a: 1");
    expect(result).toContain("b: 2");
  });
});

// ── getAllCapabilities / getAgentIdsByCapability ───────────────────────────────

describe("getAllCapabilities", () => {
  it("returns capability summaries for registered agents", () => {
    const a = makeAgent({ capabilities: ["ml-inference", "embedding"] });
    const b = makeAgent({ capabilities: ["ml-inference"] });
    createAgent(a);
    createAgent(b);

    const caps = getAllCapabilities();
    const mlCap = caps.find((c) => c.name === "ml-inference");
    expect(mlCap).toBeDefined();
    expect(mlCap!.agentCount).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array when no agents are registered (or no capabilities)", () => {
    // In an isolated context this starts empty; just verify shape
    const caps = getAllCapabilities();
    expect(Array.isArray(caps)).toBe(true);
  });
});

describe("getAgentIdsByCapability", () => {
  it("returns agent IDs that have a given capability", () => {
    const uniqueCap = `unique-cap-${counter++}`;
    const a = makeAgent({ capabilities: [uniqueCap] });
    const b = makeAgent({ capabilities: [uniqueCap] });
    createAgent(a);
    createAgent(b);

    const ids = getAgentIdsByCapability(uniqueCap);
    expect(ids).toContain(a.agentId);
    expect(ids).toContain(b.agentId);
  });

  it("returns empty array for unknown capability", () => {
    expect(getAgentIdsByCapability("nonexistent-cap")).toHaveLength(0);
  });
});

// ── recordAuditEvent / getAuditEventById / listAuditEvents ────────────────────

describe("recordAuditEvent", () => {
  it("records an event and returns it", () => {
    const event = recordAuditEvent({
      req: makeReq(),
      actor: { walletAddress: TEST_WALLET, keyId: "key-1" },
      action: "agent.created",
      resourceType: "agent",
      resourceId: `agent-audit-${counter++}`,
      ownerAgentId: "owner-agent",
      ownerWallet: TEST_WALLET,
      metadata: { provider: "anthropic", priced: false },
    });

    expect(event.auditId).toBeDefined();
    expect(event.action).toBe("agent.created");
    expect(event.actorWallet).toBe(TEST_WALLET);
    expect(event.actorKeyId).toBe("key-1");
    expect(event.resourceType).toBe("agent");
    expect(event.metadata).toMatchObject({ provider: "anthropic" });
  });

  it("records an event without optional fields", () => {
    const event = recordAuditEvent({
      req: makeReq(),
      actor: { walletAddress: TEST_WALLET },
      action: "budget.upserted",
      resourceType: "budget",
      resourceId: `budget-${counter++}`,
    });

    expect(event.auditId).toBeDefined();
    expect(event.actorKeyId).toBeUndefined();
    expect(event.ownerAgentId).toBeUndefined();
    expect(event.metadata).toBeUndefined();
  });
});

describe("getAuditEventById", () => {
  it("retrieves an existing event", () => {
    const event = recordAuditEvent({
      req: makeReq(),
      actor: { walletAddress: TEST_WALLET },
      action: "agent.created",
      resourceType: "agent",
      resourceId: `r-${counter++}`,
    });

    const found = getAuditEventById(event.auditId);
    expect(found).not.toBeNull();
    expect(found!.auditId).toBe(event.auditId);
  });

  it("returns null for unknown auditId", () => {
    expect(getAuditEventById("nonexistent")).toBeNull();
  });
});

describe("listAuditEvents", () => {
  it("lists events filtered by ownerWallet", () => {
    const uniqueWallet = "11111111111111111111111111111113";
    recordAuditEvent({
      req: makeReq(),
      actor: { walletAddress: TEST_WALLET },
      action: "agent.created",
      resourceType: "agent",
      resourceId: `r-${counter++}`,
      ownerWallet: uniqueWallet,
    });

    const events = listAuditEvents({ ownerWallet: uniqueWallet });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.ownerWallet === uniqueWallet)).toBe(true);
  });

  it("lists events filtered by ownerAgentId", () => {
    const uniqueAgent = `audit-owner-${counter++}`;
    recordAuditEvent({
      req: makeReq(),
      actor: { walletAddress: TEST_WALLET },
      action: "agent.created",
      resourceType: "agent",
      resourceId: `r-${counter++}`,
      ownerAgentId: uniqueAgent,
    });

    const events = listAuditEvents({ ownerAgentId: uniqueAgent });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.ownerAgentId === uniqueAgent)).toBe(true);
  });

  it("returns all events when no filter is applied", () => {
    recordAuditEvent({
      req: makeReq(),
      actor: { walletAddress: TEST_WALLET },
      action: "budget.upserted",
      resourceType: "budget",
      resourceId: `r-${counter++}`,
    });
    const events = listAuditEvents({});
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("respects the limit parameter", () => {
    // Record 3 more events
    for (let i = 0; i < 3; i++) {
      recordAuditEvent({
        req: makeReq(),
        actor: { walletAddress: TEST_WALLET },
        action: "budget.upserted",
        resourceType: "budget",
        resourceId: `r-${counter++}`,
      });
    }
    const events = listAuditEvents({ limit: 2 });
    expect(events.length).toBeLessThanOrEqual(2);
  });
});

// ── recommendPaymentPath ──────────────────────────────────────────────────────

describe("recommendPaymentPath", () => {
  it("returns free for agent with no price", () => {
    const rec = recommendPaymentPath({});
    expect(rec.protocol).toBe("free");
  });

  it("returns mpp for USDC agent with open channel and high call volume", () => {
    const rec = recommendPaymentPath({
      agentPrice: "1 USDC",
      hasOpenMppChannel: true,
      expectedCallsPerDay: 10,
    });
    expect(rec.protocol).toBe("mpp");
    expect(rec.reason).toMatch(/10 calls\/day/);
  });

  it("returns mpp for USDC agent with open channel and low call volume", () => {
    const rec = recommendPaymentPath({
      agentPrice: "1 USDC",
      hasOpenMppChannel: true,
      expectedCallsPerDay: 2,
    });
    expect(rec.protocol).toBe("mpp");
    expect(rec.reason).not.toMatch(/calls\/day/);
    expect(rec.priceString).toBe("1 USDC");
  });

  it("returns x402 for USDC agent without an open channel", () => {
    const rec = recommendPaymentPath({
      agentPrice: "1 USDC",
      hasOpenMppChannel: false,
    });
    expect(rec.protocol).toBe("x402");
    expect(rec.reason).toMatch(/No open MPP channel/);
  });

  it("returns x402 for SOL-priced agent", () => {
    const rec = recommendPaymentPath({
      agentPrice: "0.05 SOL",
      hasOpenMppChannel: true,
    });
    expect(rec.protocol).toBe("x402");
    expect(rec.reason).toMatch(/SOL/);
  });
});

// ── recordTaskLatency / getAgentMetrics ────────────────────────────────────────

describe("recordTaskLatency / getAgentMetrics", () => {
  const agentId = `metrics-agent-${counter++}`;

  it("records latency and reflects in metrics", () => {
    createAgent(makeAgent({ agentId }));
    recordTaskLatency(agentId, 500, true);
    recordTaskLatency(agentId, 1000, true);
    recordTaskLatency(agentId, 800, false);

    const m = getAgentMetrics(agentId);
    expect(m.agentId).toBe(agentId);
    expect(m.totalTasks).toBe(3);
    expect(m.completedTasks).toBe(2);
    expect(m.failedTasks).toBe(1);
    expect(m.avgLatencyMs).toBe(Math.round((500 + 1000 + 800) / 3));
    expect(m.uptimePct).toBe(Math.round((2 / 3) * 1000) / 10);
  });

  it("returns null latency and uptime for agent with no data", () => {
    const m = getAgentMetrics("no-data-agent");
    expect(m.totalTasks).toBe(0);
    expect(m.avgLatencyMs).toBeNull();
    expect(m.uptimePct).toBeNull();
  });

  it("respects the windowDays parameter", () => {
    const m = getAgentMetrics(agentId, 7);
    expect(m.windowDays).toBe(7);
  });
});

// ── getNetworkStats ───────────────────────────────────────────────────────────

describe("getNetworkStats", () => {
  it("returns correct structure with zero-data DB", () => {
    const stats = getNetworkStats();

    expect(stats.agents).toBeDefined();
    expect(typeof stats.agents.total).toBe("number");
    expect(typeof stats.agents.active).toBe("number");

    expect(stats.tasks).toBeDefined();
    expect(typeof stats.tasks.total).toBe("number");
    expect(typeof stats.tasks.successRate).toBe("number");

    expect(stats.payments).toBeDefined();
    expect(typeof stats.payments.totalUsdcTransacted).toBe("number");
    expect(typeof stats.payments.totalTxns).toBe("number");

    expect(stats.workflows).toBeDefined();
    expect(typeof stats.workflows.total).toBe("number");

    expect(Array.isArray(stats.topAgents)).toBe(true);
    expect(Array.isArray(stats.topCapabilities)).toBe(true);
    expect(Array.isArray(stats.activityByDay)).toBe(true);
    expect(stats.activityByDay).toHaveLength(7); // last 7 days
  });

  it("successRate is 0 when no settled tasks", () => {
    const stats = getNetworkStats();
    expect(stats.tasks.successRate).toBe(0);
  });
});

// ── validateIdempotencyKey ─────────────────────────────────────────────────────

describe("validateIdempotencyKey", () => {
  it("returns null for a valid key", () => {
    expect(validateIdempotencyKey("valid-key-12345")).toBeNull();
  });

  it("returns error message for a key that is too short", () => {
    const msg = validateIdempotencyKey("short");
    expect(msg).toMatch(/Idempotency-Key must be/);
  });

  it("returns error message for a key with invalid characters", () => {
    const msg = validateIdempotencyKey("invalid!@#$%^&*()key");
    expect(msg).toMatch(/Idempotency-Key must be/);
  });
});

describe("hashIdempotencyPayload", () => {
  it("handles payloads containing arrays", () => {
    // Covers the Array.isArray branch in the stable() helper
    const hash = hashIdempotencyPayload({ items: [3, 1, 2], name: "test" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same hash regardless of key order", () => {
    const a = hashIdempotencyPayload({ b: 2, a: 1 });
    const b = hashIdempotencyPayload({ a: 1, b: 2 });
    expect(a).toBe(b);
  });
});

// ── audit metadata JSON error path ────────────────────────────────────────────

describe("audit: invalid JSON metadata is handled gracefully", () => {
  it("returns undefined metadata when stored JSON is malformed", () => {
    const event = recordAuditEvent({
      req: makeReq(),
      actor: { walletAddress: TEST_WALLET },
      action: "budget.upserted",
      resourceType: "test",
      resourceId: `r-${counter++}`,
    });
    // Corrupt the stored metadata directly so the JSON.parse catch path runs
    getDb()
      .prepare("UPDATE audit_events SET metadata = ? WHERE audit_id = ?")
      .run("{not-valid-json", event.auditId);

    const fetched = getAuditEventById(event.auditId);
    expect(fetched!.metadata).toBeUndefined();
  });
});

// ── getDailyStats ─────────────────────────────────────────────────────────────

describe("getDailyStats", () => {
  it("returns an array with the requested number of days", () => {
    const stats = getDailyStats(7);
    expect(stats).toHaveLength(7);
    expect(stats[0]).toMatchObject({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      tasksCompleted: expect.any(Number),
      tasksFailed: expect.any(Number),
      usdcTransacted: expect.any(Number),
      newAgents: expect.any(Number),
    });
  });

  it("defaults to 30 days", () => {
    const stats = getDailyStats();
    expect(stats).toHaveLength(30);
  });

  it("returns zero counts for an empty DB", () => {
    const stats = getDailyStats(3);
    expect(stats.every((s) => s.tasksCompleted === 0 && s.tasksFailed === 0)).toBe(true);
  });
});

// ── getAllTimeLeaders ─────────────────────────────────────────────────────────

describe("getAllTimeLeaders", () => {
  it("returns topEarners and topWorkers arrays", () => {
    const leaders = getAllTimeLeaders();
    expect(Array.isArray(leaders.topEarners)).toBe(true);
    expect(Array.isArray(leaders.topWorkers)).toBe(true);
  });

  it("returns entries with correct field types", () => {
    const leaders = getAllTimeLeaders();
    if (leaders.topWorkers.length > 0) {
      const first = leaders.topWorkers[0];
      expect(typeof first.agentId).toBe("string");
      expect(typeof first.tasksCompleted).toBe("number");
    }
    if (leaders.topEarners.length > 0) {
      const first = leaders.topEarners[0];
      expect(typeof first.agentId).toBe("string");
      expect(typeof first.totalEarnedUsdc).toBe("number");
    }
  });
});
