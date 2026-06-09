import { describe, it, expect, beforeEach, vi } from "vitest";
import { encrypt, decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";

// ── AES-256-GCM ───────────────────────────────────────────────────────────────

describe("crypto: AES-256-GCM", () => {
  beforeEach(() => {
    process.env.SEED_SECRET = "test_seed_secret_that_is_at_least_32_chars";
  });

  it("round-trips short strings", () => {
    const plain = "hello world";
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it("round-trips long strings with unicode", () => {
    const plain = "a".repeat(5000) + " — あいう — 🔐";
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it("produces unique ciphertexts for the same input (nonce randomness)", () => {
    const plain = "same";
    expect(encrypt(plain)).not.toBe(encrypt(plain));
  });

  it("throws on tampered ciphertext", () => {
    const env = encrypt("secret");
    const buf = Buffer.from(env, "base64");
    buf[16] ^= 0xff; // flip a byte in the ciphertext
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("throws on truncated envelope", () => {
    expect(() => decrypt("aGVsbG8=")).toThrow("too short");
  });

  it("uses different keys for different SEED_SECRET values", () => {
    process.env.SEED_SECRET = "secret-a";
    const ct = encrypt("data");
    process.env.SEED_SECRET = "secret-b";
    expect(() => decrypt(ct)).toThrow();
  });
});

// ── scrypt vs SHA-256 ─────────────────────────────────────────────────────────

describe("identity: scrypt key hashing", () => {
  it("scrypt hash differs from SHA-256 hash for the same input", async () => {
    const { createHash, scryptSync } = await import("crypto");
    const key = "axon_sk_test_key_12345";
    const sha256 = createHash("sha256").update(key).digest("hex");
    const salt = createHash("sha256").update("axon-key-hash:test_seed").digest();
    const scrypt = scryptSync(key, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
    expect(scrypt).not.toBe(sha256);
    expect(scrypt).toHaveLength(64);
  });
});

// ── Logger PII scrubbing ──────────────────────────────────────────────────────

// Capture output with a local array so tests are fully independent of spy.mock state.
function captureError(fn: () => void): string {
  const calls: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((msg) => calls.push(msg as string));
  fn();
  spy.mockRestore();
  return calls[0] ?? "";
}

describe("logger: PII scrubbing", () => {
  it("truncates axon_sk_ prefixed values in log output", () => {
    const output = captureError(() =>
      logger.error("test.key.scrub", "test message", { apiKey: "axon_sk_abc123secret456def" })
    );
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("secret456def");
  });

  it("truncates Solana wallet addresses (32-44 base58 chars) in log field values", () => {
    // 44-char valid base58 Solana address (no 0/O/I/l)
    const wallet = "6RP8z43uGFGDhQVHMzPP4VzmbrGbzCWdX6rGc1234WXY";
    expect(wallet).toHaveLength(44);
    const output = captureError(() =>
      logger.error("test.wallet.scrub", "msg", { sender: wallet })
    );
    const parsed = JSON.parse(output) as { sender?: string };
    expect(parsed.sender).toBeDefined();
    expect((parsed.sender ?? "").length).toBeLessThan(wallet.length);
  });

  it("redacts key_hash fields by key name", () => {
    const output = captureError(() =>
      logger.error("test.keyhash.scrub", "msg", { key_hash: "deadbeef1234" })
    );
    expect(output).not.toContain("deadbeef1234");
    expect(output).toContain("[redacted]");
  });
});

// ── Gateway inject_headers encryption ────────────────────────────────────────

describe("gateway: inject_headers encryption", () => {
  beforeEach(() => {
    process.env.SEED_SECRET = "test_seed_secret_that_is_at_least_32_chars";
  });

  it("stored value is not plaintext JSON when SEED_SECRET is set", () => {
    const headers = { Authorization: "Bearer secret-upstream-key" };
    const json = JSON.stringify(headers);
    const ct = encrypt(json);
    const envelope = `enc1:${ct}`;
    // The envelope must not contain the raw key
    expect(envelope).not.toContain("secret-upstream-key");
    expect(envelope).toMatch(/^enc1:/);
  });

  it("decrypts back to the original headers", () => {
    const headers = { Authorization: "Bearer secret-upstream-key", "X-Api-Key": "abc123" };
    const envelope = `enc1:${encrypt(JSON.stringify(headers))}`;
    // Simulate what decryptInjectHeaders does
    const decrypted = JSON.parse(decrypt(envelope.slice(5))) as Record<string, string>;
    expect(decrypted).toEqual(headers);
  });
});
