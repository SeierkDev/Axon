/**
 * Webhook signature verification for Axon webhook recipients.
 *
 * Axon signs every webhook delivery with HMAC-SHA256 using the webhook secret
 * returned when you registered the webhook. Verify the signature before
 * processing any payload.
 *
 * Usage:
 *   import { verifyWebhookSignature } from "@axon/sdk";
 *   const ok = verifyWebhookSignature({ secret, rawBody, signature, timestamp });
 *   if (!ok) throw new Error("Invalid webhook signature");
 */

// ── Browser + Node dual-compatible HMAC ──────────────────────────────────────

async function computeHmac(secret: string, message: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    // Web Crypto API (browser + Node 18+)
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Node.js crypto (< 18 or environments without Web Crypto)
  const { createHmac } = await import("crypto");
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** Constant-time string comparison to prevent timing attacks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface VerifyWebhookOptions {
  /** The webhook secret returned when you registered the webhook. */
  secret: string;
  /** The raw request body as a string (do NOT JSON.parse first). */
  rawBody: string;
  /** The value of the `X-Axon-Signature` header (e.g. `sha256=abc123…`). */
  signature: string;
  /** The value of the `X-Axon-Timestamp` header (Unix seconds as a string). */
  timestamp: string | number;
  /** Maximum age of the webhook in seconds before it is rejected. Default: 300. */
  maxAgeSeconds?: number;
}

/**
 * Verifies the HMAC-SHA256 signature on an Axon webhook delivery.
 *
 * Returns `true` if the signature is valid and the delivery is not stale.
 * Returns `false` otherwise — treat the payload as untrusted.
 */
export async function verifyWebhookSignature(opts: VerifyWebhookOptions): Promise<boolean> {
  const { secret, rawBody, signature, timestamp, maxAgeSeconds = 300 } = opts;

  // Strip the "sha256=" prefix
  const receivedHex = signature.startsWith("sha256=") ? signature.slice(7) : signature;

  // Check timestamp freshness — reject replays
  const ts = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
  if (!Number.isFinite(ts)) return false;
  const ageSeconds = Math.floor(Date.now() / 1000) - ts;
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) return false;

  // Recompute the expected signature: HMAC-SHA256(`${timestamp}.${body}`)
  const expectedHex = await computeHmac(secret, `${ts}.${rawBody}`);

  return safeEqual(receivedHex, expectedHex);
}
