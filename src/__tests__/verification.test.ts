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
        payToAddress: "11111111111111111111111111111111",
        asset: "USDC",
        network: "solana-devnet",
        maxAmountRequired: "100000",
        requiredDeadlineSeconds: 300,
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
