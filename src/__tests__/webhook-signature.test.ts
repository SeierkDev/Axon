// Tests for the SDK's webhook signature verification helper
// (packages/sdk/src/webhooks.ts). The server side (signing + delivery) is
// covered in webhooks.test.ts; here we verify the consumer-facing verifier.

import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyWebhookSignature } from "../../packages/sdk/src/webhooks";

// Replicate the server's exact signing scheme (src/lib/webhooks.ts `sign`) so
// these tests prove the SDK helper accepts precisely what Axon actually sends:
//   HMAC-SHA256(`${timestamp}.${body}`) -> hex, sent as `sha256=<hex>`.
function serverSign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

const SECRET = "whsec_test_0123456789abcdef";
const BODY = JSON.stringify({ event: "task.completed", taskId: "task_abc", amount: "0.10 USDC" });
const now = () => Math.floor(Date.now() / 1000);

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature produced the way the server signs", async () => {
    const ts = now();
    const signature = `sha256=${serverSign(SECRET, ts, BODY)}`;
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: ts })).toBe(true);
  });

  it("accepts a signature without the sha256= prefix", async () => {
    const ts = now();
    const signature = serverSign(SECRET, ts, BODY);
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: ts })).toBe(true);
  });

  it("accepts a string timestamp (as sent in the header)", async () => {
    const ts = now();
    const signature = `sha256=${serverSign(SECRET, ts, BODY)}`;
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: String(ts) })).toBe(true);
  });

  it("verifies via the Node crypto fallback when Web Crypto is unavailable", async () => {
    const ts = now();
    const signature = `sha256=${serverSign(SECRET, ts, BODY)}`;
    // Force the helper down its `createHmac` branch by removing crypto.subtle,
    // then restore it so other tests keep using the Web Crypto path.
    const cryptoObj = globalThis.crypto as unknown as { subtle?: unknown };
    const original = cryptoObj.subtle;
    try {
      Object.defineProperty(cryptoObj, "subtle", { value: undefined, configurable: true });
      expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: ts })).toBe(true);
    } finally {
      Object.defineProperty(cryptoObj, "subtle", { value: original, configurable: true });
    }
  });

  it("rejects a tampered body", async () => {
    const ts = now();
    const signature = `sha256=${serverSign(SECRET, ts, BODY)}`;
    const tampered = BODY.replace("0.10", "9.99");
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: tampered, signature, timestamp: ts })).toBe(false);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const ts = now();
    const signature = `sha256=${serverSign("whsec_attacker", ts, BODY)}`;
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: ts })).toBe(false);
  });

  it("rejects a stale delivery (older than the default 300s window)", async () => {
    const ts = now() - 301;
    const signature = `sha256=${serverSign(SECRET, ts, BODY)}`;
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: ts })).toBe(false);
  });

  it("respects a custom maxAgeSeconds window", async () => {
    const ts = now() - 120;
    const signature = `sha256=${serverSign(SECRET, ts, BODY)}`;
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: ts, maxAgeSeconds: 60 })).toBe(false);
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: ts, maxAgeSeconds: 600 })).toBe(true);
  });

  it("rejects a future-dated timestamp", async () => {
    const ts = now() + 120;
    const signature = `sha256=${serverSign(SECRET, ts, BODY)}`;
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: ts })).toBe(false);
  });

  it("rejects a non-numeric timestamp", async () => {
    const ts = now();
    const signature = `sha256=${serverSign(SECRET, ts, BODY)}`;
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: "not-a-number" })).toBe(false);
  });

  it("rejects a malformed signature of the right shape", async () => {
    const ts = now();
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature: "sha256=deadbeef", timestamp: ts })).toBe(false);
  });
});
