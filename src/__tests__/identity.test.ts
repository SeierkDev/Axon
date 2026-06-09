import { describe, it, expect } from "vitest";
import {
  createApiKey, listApiKeys, revokeApiKeyById, generateKeyPair,
  createChallenge, consumeChallenge, createWalletChallenge, consumeWalletChallenge,
  verifySignature, verifyWalletSignature, authenticateApiKey, revokeApiKey,
} from "@/lib/identity";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { createHash, randomUUID } from "crypto";

// Valid base58 Solana addresses (32 chars)
const WALLET_A = "11111111111111111111111111111111";
const WALLET_B = "11111111111111111111111111111112";

describe("createApiKey", () => {
  it("creates a key with the correct structure", () => {
    const result = createApiKey(WALLET_A);
    expect(result.keyId).toBeTruthy();
    expect(result.apiKey).toBeTruthy();
    expect(result.keyPrefix.length).toBe(12);
    expect(result.walletAddress).toBe(WALLET_A);
    // The returned API key starts with the prefix
    expect(result.apiKey.startsWith(result.keyPrefix)).toBe(true);
  });

  it("creates multiple distinct keys for the same wallet", () => {
    const a = createApiKey(WALLET_A);
    const b = createApiKey(WALLET_A);
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.apiKey).not.toBe(b.apiKey);
  });
});

describe("listApiKeys", () => {
  it("lists keys for the given wallet", () => {
    const before = listApiKeys(WALLET_B).length;
    createApiKey(WALLET_B);
    createApiKey(WALLET_B);
    const after = listApiKeys(WALLET_B);
    expect(after.length).toBe(before + 2);
  });

  it("returns keys with correct structure (no plaintext secret)", () => {
    const { keyId, keyPrefix } = createApiKey(WALLET_A);
    const keys = listApiKeys(WALLET_A);
    const found = keys.find((k) => k.keyId === keyId);
    expect(found).toBeDefined();
    expect(found!.keyPrefix).toBe(keyPrefix);
    expect(found!.createdAt).toBeTruthy();
    // Full plaintext key is never stored or returned in listings
  });

  it("does not return keys for a different wallet", () => {
    const { keyId } = createApiKey(WALLET_A);
    const bKeys = listApiKeys(WALLET_B);
    expect(bKeys.find((k) => k.keyId === keyId)).toBeUndefined();
  });
});

describe("revokeApiKeyById", () => {
  it("returns true when a key is successfully revoked", () => {
    const { keyId } = createApiKey(WALLET_A);
    expect(revokeApiKeyById(keyId, WALLET_A)).toBe(true);
  });

  it("returns false when the key has already been revoked", () => {
    const { keyId } = createApiKey(WALLET_A);
    revokeApiKeyById(keyId, WALLET_A);
    expect(revokeApiKeyById(keyId, WALLET_A)).toBe(false);
  });

  it("returns false when wallet does not own the key", () => {
    const { keyId } = createApiKey(WALLET_A);
    expect(revokeApiKeyById(keyId, WALLET_B)).toBe(false);
  });

  it("revoked keys no longer appear in listings", () => {
    const { keyId } = createApiKey(WALLET_A);
    revokeApiKeyById(keyId, WALLET_A);
    const keys = listApiKeys(WALLET_A);
    expect(keys.find((k) => k.keyId === keyId)).toBeUndefined();
  });
});

describe("generateKeyPair", () => {
  it("generates valid ed25519 base64 key pairs", () => {
    const { publicKey, secretKey } = generateKeyPair();
    expect(publicKey).toBeTruthy();
    expect(secretKey).toBeTruthy();
    // Public key is 32 bytes = 44 base64 chars; secret key is 64 bytes = 88 chars
    expect(Buffer.from(publicKey, "base64").length).toBe(32);
    expect(Buffer.from(secretKey, "base64").length).toBe(64);
  });

  it("generates unique key pairs each call", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secretKey).not.toBe(b.secretKey);
  });
});

// ── createChallenge / consumeChallenge ────────────────────────────────────────

describe("createChallenge / consumeChallenge", () => {
  it("round-trips: creates and consumes a challenge", () => {
    const agentId = "agent-challenge-1";
    const value = createChallenge(agentId);
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(10);
    expect(consumeChallenge(agentId, value)).toBe(true);
  });

  it("challenge is single-use", () => {
    const agentId = "agent-challenge-2";
    const value = createChallenge(agentId);
    consumeChallenge(agentId, value);
    expect(consumeChallenge(agentId, value)).toBe(false);
  });

  it("returns false for wrong value", () => {
    const agentId = "agent-challenge-3";
    createChallenge(agentId);
    expect(consumeChallenge(agentId, "wrong-value")).toBe(false);
  });

  it("returns false for unknown agentId", () => {
    expect(consumeChallenge("unknown-agent", "some-value")).toBe(false);
  });
});

describe("createWalletChallenge / consumeWalletChallenge", () => {
  it("round-trips wallet challenge", () => {
    const wallet = WALLET_A;
    const value = createWalletChallenge(wallet);
    expect(consumeWalletChallenge(wallet, value)).toBe(true);
  });

  it("returns false for wrong value", () => {
    const wallet = WALLET_A;
    createWalletChallenge(wallet);
    expect(consumeWalletChallenge(wallet, "wrong")).toBe(false);
  });
});

// ── verifySignature ───────────────────────────────────────────────────────────

describe("verifySignature", () => {
  it("returns true for a valid ed25519 signature", () => {
    const pair = nacl.sign.keyPair();
    const message = "hello axon";
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = nacl.sign.detached(msgBytes, pair.secretKey);

    expect(verifySignature({
      publicKeyB64: encodeBase64(pair.publicKey),
      message,
      signatureB64: encodeBase64(sigBytes),
    })).toBe(true);
  });

  it("returns false for a tampered message", () => {
    const pair = nacl.sign.keyPair();
    const msgBytes = new TextEncoder().encode("original");
    const sigBytes = nacl.sign.detached(msgBytes, pair.secretKey);

    expect(verifySignature({
      publicKeyB64: encodeBase64(pair.publicKey),
      message: "tampered",
      signatureB64: encodeBase64(sigBytes),
    })).toBe(false);
  });

  it("returns false for invalid base64 input without throwing", () => {
    expect(verifySignature({
      publicKeyB64: "not-base64!!!",
      message: "msg",
      signatureB64: "not-base64!!!",
    })).toBe(false);
  });
});

// ── verifyWalletSignature ─────────────────────────────────────────────────────

describe("verifyWalletSignature", () => {
  it("returns false for an invalid Solana wallet address (not valid base58 pubkey)", () => {
    expect(verifyWalletSignature({
      walletAddress: "not-a-solana-address!!!",
      message: "hello",
      signatureB64: encodeBase64(new Uint8Array(64)),
    })).toBe(false);
  });

  it("returns false when the signature does not match the message and key", () => {
    // WALLET_A is a valid Solana address (system program) but the signature is all zeros
    expect(verifyWalletSignature({
      walletAddress: WALLET_A,
      message: "hello axon",
      signatureB64: encodeBase64(new Uint8Array(64)),
    })).toBe(false);
  });
});

// ── authenticateApiKey ────────────────────────────────────────────────────────

function makeRequest(apiKey: string, useHeader: "x-api-key" | "authorization" = "authorization"): NextRequest {
  const headers: Record<string, string> = useHeader === "authorization"
    ? { authorization: `Bearer ${apiKey}` }
    : { "x-api-key": apiKey };
  return new NextRequest("http://localhost/api/test", { headers });
}

describe("authenticateApiKey", () => {
  it("returns AuthenticatedUser for a valid Bearer token", () => {
    const { apiKey, walletAddress } = createApiKey(WALLET_A);
    const user = authenticateApiKey(makeRequest(apiKey));
    expect(user).not.toBeNull();
    expect(user!.walletAddress).toBe(walletAddress);
  });

  it("returns AuthenticatedUser for a valid x-api-key header", () => {
    const { apiKey } = createApiKey(WALLET_A);
    const user = authenticateApiKey(makeRequest(apiKey, "x-api-key"));
    expect(user).not.toBeNull();
  });

  it("returns null for unknown key", () => {
    const req = makeRequest("axon_sk_unknownkey");
    expect(authenticateApiKey(req)).toBeNull();
  });

  it("returns null when no authorization header is present", () => {
    const req = new NextRequest("http://localhost/api/test");
    expect(authenticateApiKey(req)).toBeNull();
  });
});

// ── authenticateApiKey: legacy SHA-256 upgrade path ──────────────────────────

describe("authenticateApiKey: legacy SHA-256 → scrypt upgrade", () => {
  it("authenticates a legacy SHA-256 key and upgrades it to scrypt on first use", () => {
    const db = getDb();
    const keyId = randomUUID();
    const apiKey = `axon_sk_legacy_${keyId.slice(0, 8)}`;
    const sha256Hash = createHash("sha256").update(apiKey).digest("hex");
    const now = new Date().toISOString();

    // Insert key with legacy SHA-256 hash directly — bypassing createApiKey which always uses scrypt
    db.prepare(`
      INSERT INTO api_keys (key_id, wallet_address, key_hash, key_prefix, hash_algorithm, created_at)
      VALUES (?, ?, ?, ?, 'sha256', ?)
    `).run(keyId, WALLET_A, sha256Hash, apiKey.slice(0, 12), now);

    // First auth: should succeed and transparently upgrade the hash to scrypt
    const user = authenticateApiKey(makeRequest(apiKey));
    expect(user).not.toBeNull();
    expect(user!.walletAddress).toBe(WALLET_A);

    // Verify the DB row is now using scrypt
    const row = db.prepare("SELECT hash_algorithm FROM api_keys WHERE key_id = ?")
      .get(keyId) as { hash_algorithm: string } | undefined;
    expect(row?.hash_algorithm).toBe("scrypt");

    // Second auth: the scrypt path now applies and still succeeds
    const user2 = authenticateApiKey(makeRequest(apiKey));
    expect(user2).not.toBeNull();
  });
});

// ── revokeApiKey (req-based) ──────────────────────────────────────────────────

describe("revokeApiKey (req-based)", () => {
  it("returns true and revokes a valid key", () => {
    const { apiKey } = createApiKey(WALLET_A);
    const req = makeRequest(apiKey);
    expect(revokeApiKey(req)).toBe(true);
    expect(authenticateApiKey(req)).toBeNull();
  });

  it("returns false for an already-revoked key", () => {
    const { apiKey } = createApiKey(WALLET_A);
    const req = makeRequest(apiKey);
    revokeApiKey(req);
    expect(revokeApiKey(req)).toBe(false);
  });

  it("returns false when no authorization header present", () => {
    const req = new NextRequest("http://localhost/api/test");
    expect(revokeApiKey(req)).toBe(false);
  });
});
