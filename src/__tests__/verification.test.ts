// Tests for src/lib/verification.ts — verifyAgentEndpoint().
// publicHttpFetch is mocked via vi.mock so no real HTTP calls are made.
// The real DB (in-memory test instance) is used for the verification_status UPDATE.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockPublicHttpFetch } = vi.hoisted(() => ({
  mockPublicHttpFetch: vi.fn(),
}));

vi.mock("@/lib/urlSecurity", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/urlSecurity")>();
  return { ...original, publicHttpFetch: mockPublicHttpFetch };
});

import { getDb } from "@/lib/db";
import { verifyAgentEndpoint } from "@/lib/verification";
import { logger } from "@/lib/logger";
import { encodeRequirements, X402_VERSION, X402_SCHEME } from "@/lib/x402";

const AGENT_ID = "verify-test-agent";
const ENDPOINT = "https://test.example.com/agent";

function makeValidX402Header(): string {
  const req = {
    version: X402_VERSION,
    accepts: [
      {
        scheme: X402_SCHEME,
        resource: ENDPOINT,
        description: "test",
        payToAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        asset: "USDC",
        network: "solana-devnet",
        maxAmountRequired: "100000",
        requiredDeadlineSeconds: 300,
        mimeType: "application/json",
        extra: { name: "USD Coin", symbol: "USDC", decimals: 6, contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      },
    ],
  };
  return encodeRequirements(req);
}

beforeEach(() => {
  // Insert a minimal agent row so the UPDATE in verifyAgentEndpoint finds a row.
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO agents
      (agent_id, name, capabilities, public_key, wallet_address, reputation, created_at)
    VALUES (?, 'Verify Test', '[]', 'pk', 'wallet', 0, datetime('now'))
  `).run(AGENT_ID);
});

afterEach(() => {
  getDb().prepare("DELETE FROM agents WHERE agent_id = ?").run(AGENT_ID);
  mockPublicHttpFetch.mockReset();
});

// ── unreachable ───────────────────────────────────────────────────────────────

describe("verifyAgentEndpoint: unreachable (fetch throws)", () => {
  it("returns status=unreachable when fetch throws a network error", async () => {
    mockPublicHttpFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
    expect(result.status).toBe("unreachable");
    expect(result.latencyMs).toBeNull();
    expect(result.detail).toContain("ECONNREFUSED");
    expect(result.agentId).toBe(AGENT_ID);
  });

  it("detail falls back to 'Connection failed' for non-Error throws", async () => {
    mockPublicHttpFetch.mockRejectedValueOnce("string-error");
    const result = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
    expect(result.status).toBe("unreachable");
    expect(result.detail).toBe("Connection failed");
  });
});

// ── reachable: non-402 status ──────────────────────────────────────────────────

describe("verifyAgentEndpoint: reachable — non-402 response", () => {
  it("returns status=reachable for HTTP 200", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("ok", { status: 200 })
    );
    const result = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
    expect(result.status).toBe("reachable");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.detail).toMatch(/HTTP 200/);
  });

  it("returns status=reachable for HTTP 404", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("not found", { status: 404 })
    );
    const result = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
    expect(result.status).toBe("reachable");
    expect(result.detail).toMatch(/HTTP 404/);
  });
});

// ── reachable: 402 without X-Payment-Required header ─────────────────────────

describe("verifyAgentEndpoint: reachable — 402 but no X-Payment-Required header", () => {
  it("returns status=reachable with appropriate detail", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("Payment required", { status: 402 })
    );
    const result = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
    expect(result.status).toBe("reachable");
    expect(result.detail).toMatch(/missing/);
    expect(typeof result.latencyMs).toBe("number");
  });
});

// ── reachable: 402 with invalid X-Payment-Required header ────────────────────

describe("verifyAgentEndpoint: reachable — 402 with undecodeable X-Payment-Required", () => {
  it("returns status=reachable when the header value cannot be decoded", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("Payment required", {
        status: 402,
        headers: { "x-payment-required": "not-valid-base64!!!!" },
      })
    );
    const result = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
    expect(result.status).toBe("reachable");
    expect(result.detail).toMatch(/could not be decoded/);
  });
});

// ── x402_compliant ────────────────────────────────────────────────────────────

describe("verifyAgentEndpoint: x402_compliant — valid 402 + valid header", () => {
  it("returns status=x402_compliant when 402 includes a decodeable X-Payment-Required header", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("Payment required", {
        status: 402,
        headers: { "x-payment-required": makeValidX402Header() },
      })
    );
    const result = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
    expect(result.status).toBe("x402_compliant");
    expect(result.detail).toMatch(/USDC/);
    expect(result.detail).toMatch(/solana-devnet/);
    expect(typeof result.latencyMs).toBe("number");
  });
});

// ── DB persistence ────────────────────────────────────────────────────────────

describe("verifyAgentEndpoint: persists status to DB", () => {
  it("writes the returned status to agents.verification_status", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("ok", { status: 200 })
    );
    await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
    const row = getDb()
      .prepare("SELECT verification_status FROM agents WHERE agent_id = ?")
      .get(AGENT_ID) as { verification_status: string } | undefined;
    expect(row?.verification_status).toBe("reachable");
  });
});

// ── only a change is logged ──────────────────────────────────────────────────

describe("verifyAgentEndpoint: logs a status change, not every check", () => {
  it("reports changed=true and logs once when the status moves, then stays quiet", async () => {
    const info = vi.spyOn(logger, "info");
    try {
      mockPublicHttpFetch.mockResolvedValue(new Response("ok", { status: 200 }));
      const first = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
      const second = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
      expect(first.changed).toBe(true);   // unverified -> reachable
      expect(second.changed).toBe(false); // reachable -> reachable
      const changes = info.mock.calls.filter((c) => c[0] === "agent.verification_changed");
      expect(changes).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  it("warns when an agent becomes unreachable", async () => {
    const warn = vi.spyOn(logger, "warn");
    try {
      mockPublicHttpFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const result = await verifyAgentEndpoint(AGENT_ID, ENDPOINT);
      expect(result.changed).toBe(true);
      expect(warn.mock.calls.some((c) => c[0] === "agent.verification_changed")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── the functional POST probe is periodic for sweeps ──────────────────────────

describe("verifyAgentEndpoint: periodic functional probe", () => {
  // Own agent ids: the probe clock is per agent and outlives a single test.
  function seed(id: string) {
    getDb().prepare(`
      INSERT OR REPLACE INTO agents
        (agent_id, name, capabilities, public_key, wallet_address, reputation, created_at)
      VALUES (?, 'Probe Test', '[]', 'pk', 'wallet', 0, datetime('now'))
    `).run(id);
  }

  it("sends the POST task once, then only the GET until the interval passes", async () => {
    const id = "probe-periodic-agent";
    seed(id);
    try {
      mockPublicHttpFetch.mockImplementation(async () => new Response("{}", { status: 200 }));
      await verifyAgentEndpoint(id, ENDPOINT, { functionalProbe: "periodic" });
      await verifyAgentEndpoint(id, ENDPOINT, { functionalProbe: "periodic" });
      const methods = mockPublicHttpFetch.mock.calls.map((c) => (c[1] as RequestInit).method);
      expect(methods).toEqual(["GET", "POST", "GET"]);
    } finally {
      getDb().prepare("DELETE FROM agents WHERE agent_id = ?").run(id);
    }
  });

  it("an explicit verify still sends the POST task every time", async () => {
    const id = "probe-always-agent";
    seed(id);
    try {
      mockPublicHttpFetch.mockImplementation(async () => new Response("{}", { status: 200 }));
      await verifyAgentEndpoint(id, ENDPOINT, { functionalProbe: "periodic" });
      await verifyAgentEndpoint(id, ENDPOINT);
      const methods = mockPublicHttpFetch.mock.calls.map((c) => (c[1] as RequestInit).method);
      expect(methods).toEqual(["GET", "POST", "GET", "POST"]);
    } finally {
      getDb().prepare("DELETE FROM agents WHERE agent_id = ?").run(id);
    }
  });
});
