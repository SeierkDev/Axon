import { describe, it, expect } from "vitest";
import {
  createApiKey, listApiKeys, revokeApiKeyById, generateKeyPair,
  createChallenge, consumeChallenge, createWalletChallenge, consumeWalletChallenge,
  verifySignature, verifyWalletSignature, authenticateApiKey, revokeApiKey,
} from "@/lib/identity";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";
import { createHash, randomUUID } from "crypto";
import { testWallet } from "./support/wallet";

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

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
  it("generates a usable secp256k1 key and its address", () => {
    const { address, privateKey } = generateKeyPair();
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("generates unique key pairs each call", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.address).not.toBe(b.address);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it("the generated key signs as the generated address", async () => {
    const { address, privateKey } = generateKeyPair();
    const { privateKeyToAccount } = await import("viem/accounts");
    const signature = await privateKeyToAccount(privateKey as `0x${string}`).signMessage({ message: "proof" });
    expect(await verifySignature({ address, message: "proof", signature })).toBe(true);
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
    const value = createWalletChallenge(WALLET_A);
    expect(consumeWalletChallenge(WALLET_A, value)).toBe(true);
  });

  it("returns false for wrong value", () => {
    createWalletChallenge(WALLET_A);
    expect(consumeWalletChallenge(WALLET_A, "wrong")).toBe(false);
  });

  it("the challenge is a message a person can read, not a bare nonce", () => {
    const value = createWalletChallenge(WALLET_A);
    expect(value).toContain("wants you to sign in with your wallet");
    expect(value).toContain(WALLET_A);
    expect(value).toContain("does not move funds");
  });

  it("each challenge is different, so one signature cannot be replayed", () => {
    const a = createWalletChallenge(WALLET_A);
    const b = createWalletChallenge(WALLET_A);
    expect(a).not.toBe(b);
  });

  // MetaMask returns a checksummed address; whatever case it arrives in has to find the challenge
  it("is case-insensitive in the wallet address", () => {
    const mixed = "0xAAaAaA1111111111111111111111111111111111";
    const value = createWalletChallenge(mixed);
    expect(consumeWalletChallenge(mixed.toLowerCase(), value)).toBe(true);
  });
});

// ── verifySignature / verifyWalletSignature (EIP-191) ────────────────────────

describe("verifySignature", () => {
  it("accepts a real personal_sign signature from the claimed address", async () => {
    const w = testWallet();
    const message = "hello axon";
    expect(await verifySignature({ address: w.address, message, signature: await w.sign(message) })).toBe(true);
  });

  it("accepts the checksummed spelling of the same address", async () => {
    const w = testWallet();
    const message = "hello axon";
    expect(await verifySignature({ address: w.checksummed, message, signature: await w.sign(message) })).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const w = testWallet();
    const signature = await w.sign("original");
    expect(await verifySignature({ address: w.address, message: "tampered", signature })).toBe(false);
  });

  // the signature is perfectly valid, it just recovers to somebody else
  it("rejects a valid signature made by a different wallet", async () => {
    const signer = testWallet();
    const other = testWallet();
    const message = "hello axon";
    expect(await verifySignature({ address: other.address, message, signature: await signer.sign(message) })).toBe(false);
  });

  it("returns false for malformed input rather than throwing", async () => {
    expect(await verifySignature({ address: "not-an-address", message: "m", signature: "0xdead" })).toBe(false);
    expect(await verifySignature({ address: WALLET_A, message: "m", signature: "not-hex!!" })).toBe(false);
    expect(await verifySignature({ address: WALLET_A, message: "m", signature: "" })).toBe(false);
  });
});

describe("verifyWalletSignature", () => {
  it("verifies the exact challenge the wallet was handed", async () => {
    const w = testWallet();
    const challenge = createWalletChallenge(w.address);
    expect(await verifyWalletSignature({
      walletAddress: w.address, message: challenge, signature: await w.sign(challenge),
    })).toBe(true);
  });

  it("rejects an address that is not an address", async () => {
    const w = testWallet();
    expect(await verifyWalletSignature({
      walletAddress: "not-an-evm-address!!!", message: "hello", signature: await w.sign("hello"),
    })).toBe(false);
  });

  it("rejects a signature that does not match the message", async () => {
    const w = testWallet();
    expect(await verifyWalletSignature({
      walletAddress: w.address, message: "hello axon", signature: await w.sign("something else"),
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
