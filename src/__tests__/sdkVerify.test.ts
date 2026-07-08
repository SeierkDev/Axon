import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyWebhookSignature, verifyProofScore } from "../../packages/sdk/src/verify";

// SDK verification primitives — the client-side checks that let anyone verify Axon
// without trusting it. Webhook auth (HMAC) and a from-scratch Proof Score recompute.

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ event: "task.completed", taskId: "t1" });
  const ts = 1_700_000_000;
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

  it("accepts a genuine signature within tolerance", async () => {
    expect(await verifyWebhookSignature({ rawBody: body, signature: `sha256=${sig}`, timestamp: ts, secret, now: () => ts + 10 })).toBe(true);
  });
  it("accepts a bare hex signature (no sha256= prefix)", async () => {
    expect(await verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: ts, secret, now: () => ts + 10 })).toBe(true);
  });
  it("rejects a tampered body", async () => {
    expect(await verifyWebhookSignature({ rawBody: body + "x", signature: `sha256=${sig}`, timestamp: ts, secret, now: () => ts + 10 })).toBe(false);
  });
  it("rejects the wrong secret", async () => {
    expect(await verifyWebhookSignature({ rawBody: body, signature: `sha256=${sig}`, timestamp: ts, secret: "nope", now: () => ts + 10 })).toBe(false);
  });
  it("rejects a stale timestamp (replay window)", async () => {
    expect(await verifyWebhookSignature({ rawBody: body, signature: `sha256=${sig}`, timestamp: ts, secret, now: () => ts + 100_000 })).toBe(false);
  });
  it("rejects a malformed signature without throwing", async () => {
    expect(await verifyWebhookSignature({ rawBody: body, signature: "sha256=zzzz", timestamp: ts, secret, now: () => ts + 10 })).toBe(false);
  });
});

describe("verifyProofScore", () => {
  // 3 native tasks × 10 USDC, quality factor 0.5 → the published formula yields 500.
  const evidence = [
    { taskId: "a", network: "axon", verify: "/api/receipts/a/public", settledUsdc: 10 },
    { taskId: "b", network: "axon", verify: "/api/receipts/b/public", settledUsdc: 10 },
    { taskId: "c", network: "axon", verify: "/api/receipts/c/public", settledUsdc: 10 },
  ];
  const proof = { score: 500, components: { quality: { factor: 0.5 } } };

  function mockFetch(p: unknown, ev: unknown, receipt: unknown = { status: "completed", settlement: {} }) {
    return (async (url: string) => {
      const u = String(url);
      if (u.includes("evidence=full")) return { ok: true, json: async () => ({ evidence: ev }) };
      if (u.includes("/api/receipts/")) return { ok: true, json: async () => receipt };
      if (u.endsWith("/proof-score")) return { ok: true, json: async () => p };
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;
  }

  it("recomputes the score from public evidence and confirms it matches", async () => {
    const r = await verifyProofScore("agent", { baseUrl: "https://x", fetch: mockFetch(proof, evidence) });
    expect(r.recomputedScore).toBe(500);
    expect(r.scoreMatches).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.evidenceCount).toBe(3);
  });

  it("catches a score that doesn't match its own evidence", async () => {
    const r = await verifyProofScore("agent", { baseUrl: "https://x", fetch: mockFetch({ score: 999, components: { quality: { factor: 0.5 } } }, evidence) });
    expect(r.scoreMatches).toBe(false);
    expect(r.verified).toBe(false);
  });

  it("re-confirms every native receipt when confirmReceipts is set", async () => {
    const r = await verifyProofScore("agent", { baseUrl: "https://x", fetch: mockFetch(proof, evidence), confirmReceipts: true });
    expect(r.confirmedReceipts).toBe(3);
    expect(r.verified).toBe(true);
  });

  it("fails verification when a receipt can't be confirmed settled", async () => {
    const r = await verifyProofScore("agent", { baseUrl: "https://x", fetch: mockFetch(proof, evidence, { status: "pending" }), confirmReceipts: true });
    expect(r.confirmedReceipts).toBe(0);
    expect(r.verified).toBe(false);
  });
});
