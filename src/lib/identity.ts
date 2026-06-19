import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { createHash, randomBytes, randomUUID, scryptSync } from "crypto";
import { PublicKey } from "@solana/web3.js";
import type { NextRequest } from "next/server";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { getAgentById } from "./agents";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const API_KEY_BYTES = 32;
const API_KEY_PREFIX = "axon_sk";

// scrypt params — N=16384, r=8, p=1 are OWASP minimums for server-side token hashing.
// The salt is derived from SEED_SECRET so a DB-only leak is useless without the secret.
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function getScryptSalt(): Buffer {
  const seed = process.env.SEED_SECRET ?? "";
  if (!seed && process.env.NODE_ENV === "production") {
    // A missing SEED_SECRET means all deployments share the same scrypt salt, weakening
    // the DB-leak defence. Warn loudly so ops knows to set it.
    console.error("[identity] SEED_SECRET is not set in production — scrypt salt is constant and predictable");
  }
  return createHash("sha256").update(`axon-key-hash:${seed}`).digest();
}

function hashApiKeyScrypt(apiKey: string): string {
  return scryptSync(apiKey, getScryptSalt(), SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM,
  }).toString("hex");
}

function hashApiKeySha256Legacy(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

// ─── Challenges ───────────────────────────────────────────────────────────────

export function createChallenge(agentId: string): string {
  const db = getDb();
  const id = randomUUID();
  const value = encodeBase64(nacl.randomBytes(32));
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  db.prepare("DELETE FROM challenges WHERE expires_at < ?").run(Date.now());
  db.prepare(
    "INSERT INTO challenges (id, agent_id, value, expires_at) VALUES (?, ?, ?, ?)"
  ).run(id, agentId, value, expiresAt);
  void syncToTurso();

  return value;
}

export function createWalletChallenge(walletAddress: string): string {
  return createChallenge(`wallet:${walletAddress}`);
}

export function consumeChallenge(agentId: string, value: string): boolean {
  // Single atomic DELETE so concurrent identical submissions cannot both succeed.
  const result = getDb()
    .prepare("DELETE FROM challenges WHERE agent_id = ? AND value = ? AND expires_at > ?")
    .run(agentId, value, Date.now());
  if (result.changes > 0) void syncToTurso();
  return result.changes > 0;
}

export function consumeWalletChallenge(walletAddress: string, value: string): boolean {
  return consumeChallenge(`wallet:${walletAddress}`, value);
}

// ─── Signature verification ────────────────────────────────────────────────────

export function verifySignature(opts: {
  publicKeyB64: string;
  message: string;
  signatureB64: string;
}): boolean {
  try {
    const publicKey = decodeBase64(opts.publicKeyB64);
    const signature = decodeBase64(opts.signatureB64);
    const message = new TextEncoder().encode(opts.message);
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

export function verifyWalletSignature(opts: {
  walletAddress: string;
  message: string;
  signatureB64: string;
}): boolean {
  try {
    const publicKey = new PublicKey(opts.walletAddress);
    const signature = decodeBase64(opts.signatureB64);
    const message = new TextEncoder().encode(opts.message);
    return nacl.sign.detached.verify(message, signature, publicKey.toBytes());
  } catch {
    return false;
  }
}

// ─── API key auth ─────────────────────────────────────────────────────────────

export interface AuthenticatedUser {
  keyId: string;
  walletAddress: string;
}

interface ApiKeyRow {
  key_id: string;
  wallet_address: string;
  hash_algorithm: string;
}

function getBearerToken(req: NextRequest): string | null {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) return apiKey.trim();

  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export function createApiKey(walletAddress: string): {
  keyId: string;
  apiKey: string;
  keyPrefix: string;
  walletAddress: string;
} {
  const db = getDb();
  const keyId = randomUUID();
  const secret = randomBytes(API_KEY_BYTES).toString("base64url");
  const apiKey = `${API_KEY_PREFIX}_${secret}`;
  const keyPrefix = apiKey.slice(0, 12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO api_keys (key_id, wallet_address, key_hash, key_prefix, hash_algorithm, created_at)
    VALUES (?, ?, ?, ?, 'scrypt', ?)
  `).run(keyId, walletAddress, hashApiKeyScrypt(apiKey), keyPrefix, now);
  void syncToTurso();

  return { keyId, apiKey, keyPrefix, walletAddress };
}

export function authenticateApiKey(req: NextRequest): AuthenticatedUser | null {
  const apiKey = getBearerToken(req);
  if (!apiKey) return null;

  const db = getDb();

  // Try scrypt (new keys)
  const scryptHash = hashApiKeyScrypt(apiKey);
  let row = db
    .prepare("SELECT key_id, wallet_address, hash_algorithm FROM api_keys WHERE key_hash = ? AND hash_algorithm = 'scrypt'")
    .get(scryptHash) as ApiKeyRow | undefined;

  if (!row) {
    // Transparent migration: look up legacy SHA-256 hash and upgrade on first auth
    const sha256Hash = hashApiKeySha256Legacy(apiKey);
    const legacyRow = db
      .prepare("SELECT key_id, wallet_address, hash_algorithm FROM api_keys WHERE key_hash = ? AND hash_algorithm = 'sha256'")
      .get(sha256Hash) as ApiKeyRow | undefined;

    if (legacyRow) {
      db.prepare("UPDATE api_keys SET key_hash = ?, hash_algorithm = 'scrypt' WHERE key_id = ?")
        .run(scryptHash, legacyRow.key_id);
      row = legacyRow;
    }
  }

  if (!row) return null;

  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE key_id = ?")
    .run(new Date().toISOString(), row.key_id);

  return { keyId: row.key_id, walletAddress: row.wallet_address };
}

export function revokeApiKey(req: NextRequest): boolean {
  const apiKey = getBearerToken(req);
  if (!apiKey) return false;
  const db = getDb();

  const scryptHash = hashApiKeyScrypt(apiKey);
  if (db.prepare("DELETE FROM api_keys WHERE key_hash = ? AND hash_algorithm = 'scrypt'").run(scryptHash).changes > 0) {
    void syncToTurso();
    return true;
  }

  const sha256Hash = hashApiKeySha256Legacy(apiKey);
  const deleted = db.prepare("DELETE FROM api_keys WHERE key_hash = ? AND hash_algorithm = 'sha256'").run(sha256Hash).changes > 0;
  if (deleted) void syncToTurso();
  return deleted;
}

export interface ApiKeyInfo {
  keyId: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function listApiKeys(walletAddress: string): ApiKeyInfo[] {
  interface Row { key_id: string; key_prefix: string; created_at: string; last_used_at: string | null }
  const rows = getDb()
    .prepare(`
      SELECT key_id, key_prefix, created_at, last_used_at
      FROM api_keys WHERE wallet_address = ?
      ORDER BY created_at DESC
    `)
    .all(walletAddress) as Row[];
  return rows.map((r) => ({
    keyId: r.key_id,
    keyPrefix: r.key_prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export function revokeApiKeyById(keyId: string, walletAddress: string): boolean {
  const deleted = getDb()
    .prepare("DELETE FROM api_keys WHERE key_id = ? AND wallet_address = ?")
    .run(keyId, walletAddress).changes > 0;
  if (deleted) void syncToTurso();
  return deleted;
}

export function isAgentOwner(user: AuthenticatedUser, agentId: string): boolean {
  const agent = getAgentById(agentId);
  return !!agent?.walletAddress && agent.walletAddress === user.walletAddress;
}

// ─── Key pair generation (utility for SDK / testing) ──────────────────────────

export function generateKeyPair(): { publicKey: string; secretKey: string } {
  const pair = nacl.sign.keyPair();
  return {
    publicKey: encodeBase64(pair.publicKey),
    secretKey: encodeBase64(pair.secretKey),
  };
}
