import { createHash, randomBytes, randomUUID, scryptSync } from "crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress, type Hex } from "viem";
import type { NextRequest } from "next/server";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { getAgentById } from "./agents";
import { normalizeAddress, sameAddress } from "./address";

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
    console.error("[identity] SEED_SECRET is not set in production, scrypt salt is constant and predictable");
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

export function createChallenge(agentId: string, value = randomNonce()): string {
  const db = getDb();
  const id = randomUUID();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  db.prepare("DELETE FROM challenges WHERE expires_at < ?").run(Date.now());
  db.prepare(
    "INSERT INTO challenges (id, agent_id, value, expires_at) VALUES (?, ?, ?, ?)"
  ).run(id, agentId, value, expiresAt);
  void syncToTurso();

  return value;
}

function randomNonce(): string {
  return randomBytes(24).toString("base64url");
}

function siteName(): string {
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://axon-agents.com";
  try {
    return new URL(origin).host;
  } catch {
    return "axon-agents.com";
  }
}

/**
 * The exact text the wallet is asked to sign.
 *
 * MetaMask shows the signing payload to the person clicking approve. A bare random nonce shows up
 * as a line of gibberish, which trains people to approve things they cannot read, and it carries
 * no statement of what approving does. So the stored challenge IS this whole message, not just the
 * nonce inside it: the signature is checked against the same string that was stored and shown, and
 * there is nothing to reassemble or to trust the caller about.
 */
export function buildSignInMessage(walletAddress: string, nonce: string): string {
  return [
    `${siteName()} wants you to sign in with your wallet.`,
    "",
    `Wallet: ${walletAddress}`,
    "",
    "Signing proves you control this wallet. It does not move funds, approve tokens, or cost gas.",
    "",
    `Nonce: ${nonce}`,
  ].join("\n");
}

/** Returns the full message to sign. The caller signs it verbatim and sends it back. */
export function createWalletChallenge(walletAddress: string): string {
  const normalized = normalizeAddress(walletAddress) ?? walletAddress;
  const message = buildSignInMessage(normalized, randomNonce());
  return createChallenge(`wallet:${normalized}`, message);
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
  const normalized = normalizeAddress(walletAddress) ?? walletAddress;
  return consumeChallenge(`wallet:${normalized}`, value);
}

// ─── Signature verification ────────────────────────────────────────────────────

/**
 * EIP-191 personal_sign, which is what MetaMask produces.
 *
 * Recovery, not comparison: the signature yields the address that made it, and that address is
 * checked against the one claimed. A malformed signature makes recovery throw rather than return
 * a wrong answer, and an attacker's signature recovers to the attacker's own address, so both
 * failures land on the same `false`.
 */
async function recoveredMatches(address: string, message: string, signature: string): Promise<boolean> {
  const claimed = normalizeAddress(address);
  if (!claimed) return false;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  try {
    const recovered = await recoverMessageAddress({ message, signature: signature as Hex });
    return sameAddress(recovered, claimed);
  } catch {
    return false;
  }
}

/** An agent proving control of its own key. `address` is the agent's registered EVM address. */
export function verifySignature(opts: {
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  return recoveredMatches(opts.address, opts.message, opts.signature);
}

/** A person proving control of the wallet they are signing in with. */
export function verifyWalletSignature(opts: {
  walletAddress: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  return recoveredMatches(opts.walletAddress, opts.message, opts.signature);
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

/**
 * The raw API key as presented. Needed when a caller acts *through* the public
 * HTTP API on its own behalf — a mission hires specialists as any client would,
 * so it has to carry a real key rather than an internal privilege.
 */
export function getBearerToken(req: NextRequest): string | null {
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
  const owner = normalizeAddress(walletAddress);
  if (!owner) throw new Error(`createApiKey: '${walletAddress}' is not a wallet address`);
  const keyId = randomUUID();
  const secret = randomBytes(API_KEY_BYTES).toString("base64url");
  const apiKey = `${API_KEY_PREFIX}_${secret}`;
  const keyPrefix = apiKey.slice(0, 12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO api_keys (key_id, wallet_address, key_hash, key_prefix, hash_algorithm, created_at)
    VALUES (?, ?, ?, ?, 'scrypt', ?)
  `).run(keyId, owner, hashApiKeyScrypt(apiKey), keyPrefix, now);
  void syncToTurso();

  return { keyId, apiKey, keyPrefix, walletAddress: owner };
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
    .all(normalizeAddress(walletAddress) ?? walletAddress) as Row[];
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
    .run(keyId, normalizeAddress(walletAddress) ?? walletAddress).changes > 0;
  if (deleted) void syncToTurso();
  return deleted;
}

export function isAgentOwner(user: AuthenticatedUser, agentId: string): boolean {
  const agent = getAgentById(agentId);
  // sameAddress, not ===: the stored spelling and the signed-in one may differ in case only
  return sameAddress(agent?.walletAddress, user.walletAddress);
}

// ─── Key pair generation (utility for SDK / testing) ──────────────────────────

/**
 * A fresh secp256k1 key for an agent. `address` is what gets registered and what signatures are
 * checked against; `privateKey` never leaves the agent that generated it.
 */
export function generateKeyPair(): { address: string; privateKey: string } {
  const privateKey = generatePrivateKey();
  return {
    address: privateKeyToAccount(privateKey).address.toLowerCase(),
    privateKey,
  };
}
