// Tests for src/lib/gateway.ts
// publicHttpFetch is mocked — no real HTTP calls are made

import { vi, describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";

vi.mock("@/lib/urlSecurity", () => ({
  publicHttpFetch: vi.fn(),
  validatePublicHttpUrl: vi.fn().mockResolvedValue(null),
}));

import { publicHttpFetch } from "@/lib/urlSecurity";
import {
  createGatewayProvider,
  getGatewayProvider,
  listGatewayProviders,
  deleteGatewayProvider,
  updateGatewayProviderStatus,
  proxyToProvider,
  normalizeGatewayPrice,
  getGatewayCircuitState,
  resetGatewayCircuit,
  GatewayCircuitOpenError,
} from "@/lib/gateway";
import { createAgent } from "@/lib/agents";
import { createTask } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let seq = 0;
function uid() { return `gw-${++seq}`; }

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const id = uid();
  return {
    agentId: id,
    name: `GW Agent ${id}`,
    capabilities: ["gateway"],
    publicKey: `pk-${id}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeProxyResponse(status: number, body: string): Response {
  return {
    status,
    text: () => Promise.resolve(body),
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        cb("application/json", "content-type");
      },
    },
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── normalizeGatewayPrice ─────────────────────────────────────────────────────

describe("normalizeGatewayPrice", () => {
  it("returns the provided price when set", () => {
    expect(normalizeGatewayPrice("0.05 USDC")).toBe("0.05 USDC");
  });

  it("returns the default price when undefined or empty", () => {
    expect(normalizeGatewayPrice(undefined)).toBe("0.10 USDC");
    expect(normalizeGatewayPrice("")).toBe("0.10 USDC");
    expect(normalizeGatewayPrice("   ")).toBe("0.10 USDC");
  });
});

// ── createGatewayProvider ─────────────────────────────────────────────────────

describe("createGatewayProvider", () => {
  it("creates a provider with default method and price", () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({
      name: "Test Provider",
      endpoint: "https://api.example.com/v1",
      ownerAgentId: a.agentId,
    });
    expect(p.providerId).toBeTruthy();
    expect(p.name).toBe("Test Provider");
    expect(p.method).toBe("POST");
    expect(p.pricePerCall).toBe("0.10 USDC");
    expect(p.status).toBe("active");
    expect(p.timeoutMs).toBe(30_000);
    expect(p.forwardHeaders).toEqual([]);
    expect(p.injectHeaders).toEqual({});
  });

  it("stores inject_headers encrypted (or as plain JSON when SEED_SECRET is absent in tests)", () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({
      name: "Keyed Provider",
      endpoint: "https://api.keyed.com/",
      injectHeaders: { "X-API-Key": "secret-token" },
      ownerAgentId: a.agentId,
    });
    // After decryption (or plain JSON fallback in tests), headers should round-trip
    expect(p.injectHeaders["X-API-Key"]).toBe("secret-token");
  });

  it("encrypts inject_headers with AES-GCM when SEED_SECRET is set", () => {
    const orig = process.env.SEED_SECRET;
    process.env.SEED_SECRET = "test-seed-for-encryption";
    try {
      const a = makeAgent();
      createAgent(a);
      const p = createGatewayProvider({
        name: "Encrypted Provider",
        endpoint: "https://encrypted.example.com/",
        injectHeaders: { "Authorization": "Bearer secret-token-xyz" },
        ownerAgentId: a.agentId,
      });
      // Headers should round-trip correctly through encrypt → store → decrypt
      expect(p.injectHeaders["Authorization"]).toBe("Bearer secret-token-xyz");
    } finally {
      if (orig === undefined) delete process.env.SEED_SECRET;
      else process.env.SEED_SECRET = orig;
    }
  });

  it("stores forward headers and custom price", () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({
      name: "Forwarding Provider",
      endpoint: "https://forward.example.com/",
      forwardHeaders: ["X-Request-Id", "Accept-Language"],
      pricePerCall: "0.02 USDC",
      method: "GET",
      ownerAgentId: a.agentId,
    });
    expect(p.forwardHeaders).toEqual(["X-Request-Id", "Accept-Language"]);
    expect(p.pricePerCall).toBe("0.02 USDC");
    expect(p.method).toBe("GET");
  });
});

// ── getGatewayProvider ────────────────────────────────────────────────────────

describe("getGatewayProvider", () => {
  it("retrieves a provider by ID", () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "Lookup", endpoint: "https://look.example.com/", ownerAgentId: a.agentId });
    const found = getGatewayProvider(p.providerId);
    expect(found).not.toBeNull();
    expect(found!.providerId).toBe(p.providerId);
  });

  it("returns null for an unknown provider ID", () => {
    expect(getGatewayProvider("no-such-provider")).toBeNull();
  });
});

// ── listGatewayProviders ──────────────────────────────────────────────────────

describe("listGatewayProviders", () => {
  it("returns all providers when no status filter is given", () => {
    const a = makeAgent();
    createAgent(a);
    createGatewayProvider({ name: "Active 1", endpoint: "https://a1.example.com/", ownerAgentId: a.agentId });
    createGatewayProvider({ name: "Active 2", endpoint: "https://a2.example.com/", ownerAgentId: a.agentId });
    const list = listGatewayProviders();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by status", () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "StatusFilter", endpoint: "https://sf.example.com/", ownerAgentId: a.agentId });
    updateGatewayProviderStatus(p.providerId, "inactive");
    const active = listGatewayProviders("active");
    const inactive = listGatewayProviders("inactive");
    expect(active.some((x) => x.providerId === p.providerId)).toBe(false);
    expect(inactive.some((x) => x.providerId === p.providerId)).toBe(true);
  });
});

// ── deleteGatewayProvider ─────────────────────────────────────────────────────

describe("deleteGatewayProvider", () => {
  it("removes the provider from the database", () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "Delete Me", endpoint: "https://del.example.com/", ownerAgentId: a.agentId });
    deleteGatewayProvider(p.providerId);
    expect(getGatewayProvider(p.providerId)).toBeNull();
  });

  it("fails any queued or running tasks assigned to the deleted provider", () => {
    const sender = makeAgent();
    const a = makeAgent();
    createAgent(sender);
    createAgent(a);
    const p = createGatewayProvider({ name: "With Tasks", endpoint: "https://wt.example.com/", ownerAgentId: a.agentId });

    // Manually insert a queued task pointing at the provider's ID as toAgent
    getDb().prepare(
      "INSERT INTO agents (agent_id, name, capabilities, public_key, wallet_address, provider, reputation, category, created_at) VALUES (?, ?, '[]', ?, ?, 'anthropic', 0, 'Gateway', ?)"
    ).run(p.providerId, p.name, p.providerId, WALLET, new Date().toISOString());

    const task = createTask({ fromAgent: sender.agentId, toAgent: p.providerId, task: "proxy call" });

    deleteGatewayProvider(p.providerId);

    const updated = getDb()
      .prepare("SELECT status, error FROM tasks WHERE task_id = ?")
      .get(task.taskId) as { status: string; error: string };
    expect(updated.status).toBe("failed");
    expect(updated.error).toMatch(/deleted/i);
  });
});

// ── updateGatewayProviderStatus ───────────────────────────────────────────────

describe("updateGatewayProviderStatus", () => {
  it("toggles a provider between active and inactive", () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "Toggle", endpoint: "https://tgl.example.com/", ownerAgentId: a.agentId });

    updateGatewayProviderStatus(p.providerId, "inactive");
    expect(getGatewayProvider(p.providerId)!.status).toBe("inactive");

    updateGatewayProviderStatus(p.providerId, "active");
    expect(getGatewayProvider(p.providerId)!.status).toBe("active");
  });
});

// ── proxyToProvider ───────────────────────────────────────────────────────────

describe("proxyToProvider: blocks blocked headers", () => {
  it("never forwards authorization, cookie, or host to the upstream", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({
      name: "Block Test",
      endpoint: "https://block.example.com/",
      forwardHeaders: ["authorization", "cookie", "host", "x-custom"],
      ownerAgentId: a.agentId,
    });

    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeProxyResponse(200, "{}"));

    await proxyToProvider(p, {
      authorization: "Bearer secret",
      cookie: "session=abc",
      host: "attacker.com",
      "x-custom": "safe-value",
    }, '{"q":"test"}');

    const [, callInit] = vi.mocked(publicHttpFetch).mock.calls[0];
    const sentHeaders = (callInit as { headers: Record<string, string> }).headers;
    expect(sentHeaders.authorization).toBeUndefined();
    expect(sentHeaders.cookie).toBeUndefined();
    expect(sentHeaders.host).toBeUndefined();
    // x-custom is not blocked — it should be forwarded
    expect(sentHeaders["x-custom"]).toBe("safe-value");
  });
});

describe("proxyToProvider: injects provider headers", () => {
  it("adds inject_headers to the upstream request", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({
      name: "Inject Test",
      endpoint: "https://inject.example.com/",
      injectHeaders: { "X-API-Key": "backend-key-123" },
      ownerAgentId: a.agentId,
    });

    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeProxyResponse(200, "{}"));
    await proxyToProvider(p, {}, '{"q":"test"}');

    const [, callInit] = vi.mocked(publicHttpFetch).mock.calls[0];
    const sentHeaders = (callInit as { headers: Record<string, string> }).headers;
    expect(sentHeaders["X-API-Key"]).toBe("backend-key-123");
  });
});

describe("proxyToProvider: returns correct result", () => {
  it("returns the upstream status, body, and response headers", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({
      name: "Result Test",
      endpoint: "https://result.example.com/",
      ownerAgentId: a.agentId,
    });

    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeProxyResponse(201, '{"id":"xyz"}'));
    const result = await proxyToProvider(p, {}, '{"body":"data"}');

    expect(result.status).toBe(201);
    expect(result.body).toBe('{"id":"xyz"}');
    expect(result.headers["content-type"]).toBe("application/json");
    expect(typeof result.durationMs).toBe("number");
  });
});

describe("proxyToProvider: network error throws", () => {
  it("throws a gateway upstream error on network failure", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({
      name: "Error Test",
      endpoint: "https://error.example.com/",
      ownerAgentId: a.agentId,
    });

    vi.mocked(publicHttpFetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(proxyToProvider(p, {}, '{"q":"fail"}')).rejects.toThrow(/Gateway upstream error/);
  });
});

describe("proxyToProvider: GET method omits body", () => {
  it("does not send a body when method is GET", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({
      name: "GET Provider",
      endpoint: "https://get.example.com/",
      method: "GET",
      ownerAgentId: a.agentId,
    });

    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeProxyResponse(200, "{}"));
    await proxyToProvider(p, {}, '{"should":"be ignored"}');

    const [, callInit] = vi.mocked(publicHttpFetch).mock.calls[0];
    expect((callInit as { body: unknown }).body).toBeUndefined();
  });
});

// ── Circuit breaker ───────────────────────────────────────────────────────────

describe("gateway circuit breaker: initial state", () => {
  it("starts in closed state with 0 failures", () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "CB Init", endpoint: "https://cb.example.com/", ownerAgentId: a.agentId });
    resetGatewayCircuit(p.providerId);
    const { state, consecutiveFailures } = getGatewayCircuitState(p.providerId);
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(0);
  });
});

describe("gateway circuit breaker: opens after GATEWAY_FAILURE_THRESHOLD failures", () => {
  it("opens after 3 consecutive network errors and blocks subsequent calls", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "CB Open", endpoint: "https://cbopen.example.com/", ownerAgentId: a.agentId });
    resetGatewayCircuit(p.providerId);

    // 3 failures → opens the circuit
    for (let i = 0; i < 3; i++) {
      vi.mocked(publicHttpFetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(proxyToProvider(p, {}, "{}")).rejects.toThrow(/Gateway upstream error/);
    }

    const { state } = getGatewayCircuitState(p.providerId);
    expect(state).toBe("open");

    // 4th call must fail fast with GatewayCircuitOpenError (no HTTP attempt)
    await expect(proxyToProvider(p, {}, "{}")).rejects.toThrow(GatewayCircuitOpenError);
    // publicHttpFetch was NOT called on the 4th attempt
    expect(vi.mocked(publicHttpFetch).mock.calls.length).toBe(3);
  });
});

describe("gateway circuit breaker: success resets the circuit", () => {
  it("resets failures to 0 and closes the circuit after a successful call", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "CB Reset", endpoint: "https://cbreset.example.com/", ownerAgentId: a.agentId });
    resetGatewayCircuit(p.providerId);

    // 2 failures (below threshold — circuit stays closed)
    vi.mocked(publicHttpFetch).mockRejectedValueOnce(new Error("timeout"));
    await expect(proxyToProvider(p, {}, "{}")).rejects.toThrow();
    vi.mocked(publicHttpFetch).mockRejectedValueOnce(new Error("timeout"));
    await expect(proxyToProvider(p, {}, "{}")).rejects.toThrow();

    expect(getGatewayCircuitState(p.providerId).state).toBe("closed");
    expect(getGatewayCircuitState(p.providerId).consecutiveFailures).toBe(2);

    // 1 success → resets fully
    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeProxyResponse(200, "{}"));
    await proxyToProvider(p, {}, "{}");

    const { state, consecutiveFailures } = getGatewayCircuitState(p.providerId);
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(0);
  });
});

describe("gateway circuit breaker: GatewayCircuitOpenError contains providerId and retryAfterMs", () => {
  it("error exposes the correct providerId", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "CB Meta", endpoint: "https://cbmeta.example.com/", ownerAgentId: a.agentId });
    resetGatewayCircuit(p.providerId);

    // Exhaust threshold to open circuit
    for (let i = 0; i < 3; i++) {
      vi.mocked(publicHttpFetch).mockRejectedValueOnce(new Error("err"));
      await expect(proxyToProvider(p, {}, "{}")).rejects.toThrow();
    }

    try {
      await proxyToProvider(p, {}, "{}");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayCircuitOpenError);
      expect((err as GatewayCircuitOpenError).providerId).toBe(p.providerId);
      expect(typeof (err as GatewayCircuitOpenError).retryAfterMs).toBe("number");
    }
  });
});

describe("gateway circuit breaker: half-open probe succeeds → circuit closes", () => {
  it("transitions to half-open after recovery window and closes on success", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "CB HalfOpen", endpoint: "https://cbhalf.example.com/", ownerAgentId: a.agentId });
    resetGatewayCircuit(p.providerId);

    vi.useFakeTimers();
    try {
      // Exhaust threshold — circuit opens
      for (let i = 0; i < 3; i++) {
        vi.mocked(publicHttpFetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
        await expect(proxyToProvider(p, {}, "{}")).rejects.toThrow();
      }
      expect(getGatewayCircuitState(p.providerId).state).toBe("open");

      // Advance past the 30-second recovery window
      vi.advanceTimersByTime(31_000);

      // State should now be half-open
      expect(getGatewayCircuitState(p.providerId).state).toBe("half-open");

      // Probe succeeds → circuit closes
      vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeProxyResponse(200, "{}"));
      await proxyToProvider(p, {}, "{}");
      expect(getGatewayCircuitState(p.providerId).state).toBe("closed");
      expect(getGatewayCircuitState(p.providerId).consecutiveFailures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("gateway circuit breaker: half-open probe fails → circuit re-opens", () => {
  it("re-opens the circuit immediately when the half-open probe fails", async () => {
    const a = makeAgent();
    createAgent(a);
    const p = createGatewayProvider({ name: "CB HalfFail", endpoint: "https://cbhalffail.example.com/", ownerAgentId: a.agentId });
    resetGatewayCircuit(p.providerId);

    vi.useFakeTimers();
    try {
      // Exhaust threshold — circuit opens
      for (let i = 0; i < 3; i++) {
        vi.mocked(publicHttpFetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
        await expect(proxyToProvider(p, {}, "{}")).rejects.toThrow();
      }

      // Advance past recovery window → half-open
      vi.advanceTimersByTime(31_000);
      expect(getGatewayCircuitState(p.providerId).state).toBe("half-open");

      // Probe fails → circuit re-opens immediately
      vi.mocked(publicHttpFetch).mockRejectedValueOnce(new Error("still down"));
      await expect(proxyToProvider(p, {}, "{}")).rejects.toThrow(/Gateway upstream error/);
      expect(getGatewayCircuitState(p.providerId).state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});
