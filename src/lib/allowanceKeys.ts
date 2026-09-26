// Allowance keys: API keys that can only pay from their wallet's on-chain allowance.
//
// This is what an owner hands to Claude, Cursor, Grok or their own agent. It can hire and pay, and
// read what it hired. It cannot register or edit agents, mint keys, spend an earned balance, or use
// any route that was not written to take it (identity.ts refuses it everywhere else by default).
//
// Each key carries its own limits, checked by the server before anything is reserved. The contract's
// rules are the hard lock and hold whatever happens here; these are a second lock under them, so an
// owner can give one assistant less than the whole allowance, and a leaked key is bounded by its own
// limits and its expiry even when the allowance holds more. Two hires racing one key can both pass
// this check; the contract's daily limit still holds, which is why that one is the hard lock.

import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { createApiKey, revokeApiKeyById } from "./identity";
import { normalizeAddress } from "./address";
import { formatEth } from "./money";
import {
  DEFAULT_MAX_PER_TASK_WEI,
  DEFAULT_MAX_PER_DAY_WEI,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  MAX_ALLOWED_AGENTS,
  utcDay,
} from "./allowancePolicy";

export interface AllowanceKeyLimits {
  maxPerTaskWei: bigint;
  maxPerDayWei: bigint;
  /** null: any agent the allowance itself permits. */
  allowedAgents: string[] | null;
  expiresAt: string;
}

export interface AllowanceKeyInput {
  label?: string;
  maxPerTaskWei?: bigint;
  maxPerDayWei?: bigint;
  allowedAgents?: string[] | null;
  expiresInDays?: number;
}

export interface AllowanceKeyInfo extends AllowanceKeyLimits {
  keyId: string;
  keyPrefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  spentTodayWei: bigint;
}

/** Why these limits cannot be used, or null. The defaults match a new allowance's. */
export function keyInputError(input: AllowanceKeyInput): string | null {
  const perTask = input.maxPerTaskWei ?? DEFAULT_MAX_PER_TASK_WEI;
  const perDay = input.maxPerDayWei ?? DEFAULT_MAX_PER_DAY_WEI;
  if (perTask <= 0n) return "The per-task limit must be above zero";
  if (perDay < perTask) return "The daily limit cannot be below the per-task limit";
  const days = input.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
    return `A key expires in 1 to ${MAX_EXPIRY_DAYS} days`;
  }
  if (input.label !== undefined && (input.label.trim() === "" || input.label.length > 60)) {
    return "A label is 1 to 60 characters";
  }
  if (input.allowedAgents) {
    const ids = input.allowedAgents.map((a) => a.trim());
    if (ids.length === 0) return "An allowed-agents list cannot be empty; leave it out to allow any agent";
    if (ids.length > MAX_ALLOWED_AGENTS) return `At most ${MAX_ALLOWED_AGENTS} allowed agents`;
    if (ids.some((a) => a === "")) return "An allowed agent id is empty";
    if (new Set(ids).size !== ids.length) return "An allowed agent is listed twice";
  }
  return null;
}

/** Mint an allowance key for a wallet. The raw key is returned once and never stored. */
export function createAllowanceKey(walletAddress: string, input: AllowanceKeyInput = {}) {
  const error = keyInputError(input);
  if (error) throw new Error(error);
  const limits: AllowanceKeyLimits = {
    maxPerTaskWei: input.maxPerTaskWei ?? DEFAULT_MAX_PER_TASK_WEI,
    maxPerDayWei: input.maxPerDayWei ?? DEFAULT_MAX_PER_DAY_WEI,
    allowedAgents: input.allowedAgents ? input.allowedAgents.map((a) => a.trim()) : null,
    expiresAt: new Date(Date.now() + (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 86_400_000).toISOString(),
  };

  const db = getDb();
  let created!: ReturnType<typeof createApiKey>;
  db.transaction(() => {
    created = createApiKey(walletAddress, { scope: "allowance", label: input.label?.trim() });
    db.prepare(`
      INSERT INTO allowance_key_limits (key_id, max_per_task_wei, max_per_day_wei, allowed_agents, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      created.keyId,
      limits.maxPerTaskWei.toString(),
      limits.maxPerDayWei.toString(),
      limits.allowedAgents ? JSON.stringify(limits.allowedAgents) : null,
      limits.expiresAt,
    );
  })();
  void syncToTurso();
  return { ...created, label: input.label?.trim() ?? null, limits };
}

interface LimitsRow {
  max_per_task_wei: string;
  max_per_day_wei: string;
  allowed_agents: string | null;
  expires_at: string;
}

function toLimits(row: LimitsRow): AllowanceKeyLimits {
  return {
    maxPerTaskWei: BigInt(row.max_per_task_wei),
    maxPerDayWei: BigInt(row.max_per_day_wei),
    allowedAgents: row.allowed_agents ? (JSON.parse(row.allowed_agents) as string[]) : null,
    expiresAt: row.expires_at,
  };
}

export function getKeyLimits(keyId: string): AllowanceKeyLimits | null {
  const row = getDb().prepare("SELECT * FROM allowance_key_limits WHERE key_id = ?").get(keyId) as LimitsRow | undefined;
  return row ? toLimits(row) : null;
}

/**
 * What a key has committed today (UTC), in ETH terms. Released and reclaimed reservations do not
 * count: failed work does not use up a budget, here or on chain.
 */
export function keySpentTodayWei(keyId: string, nowMs = Date.now()): bigint {
  const dayStart = new Date(utcDay(nowMs / 1000) * 86_400_000).toISOString();
  const rows = getDb().prepare(`
    SELECT eth_wei FROM allowance_reservations
    WHERE api_key_id = ? AND created_at >= ? AND state IN ('reserved', 'settled') AND eth_wei IS NOT NULL
  `).all(keyId, dayStart) as { eth_wei: string }[];
  return rows.reduce((sum, r) => sum + BigInt(r.eth_wei), 0n);
}

/** Why this key may not pay for this hire, in words for the caller, or null when it may. */
export function keyLimitError(keyId: string, toAgent: string, ethWei: bigint, nowMs = Date.now()): string | null {
  const limits = getKeyLimits(keyId);
  if (!limits) return "This allowance key has no limits on record";
  if (Date.parse(limits.expiresAt) <= nowMs) return "This allowance key has expired";
  if (limits.allowedAgents && !limits.allowedAgents.includes(toAgent)) {
    return "This agent is not on this key's allowed list";
  }
  if (ethWei > limits.maxPerTaskWei) {
    return `This hire costs ${formatEth(ethWei)}, over this key's per-task limit of ${formatEth(limits.maxPerTaskWei)}`;
  }
  const spent = keySpentTodayWei(keyId, nowMs);
  if (spent + ethWei > limits.maxPerDayWei) {
    const left = limits.maxPerDayWei > spent ? limits.maxPerDayWei - spent : 0n;
    return `This hire costs ${formatEth(ethWei)} and ${formatEth(left)} of this key's daily limit is left`;
  }
  return null;
}

export function listAllowanceKeys(walletAddress: string): AllowanceKeyInfo[] {
  const owner = normalizeAddress(walletAddress) ?? walletAddress;
  const rows = getDb().prepare(`
    SELECT k.key_id, k.key_prefix, k.label, k.created_at, k.last_used_at,
           l.max_per_task_wei, l.max_per_day_wei, l.allowed_agents, l.expires_at
    FROM api_keys k JOIN allowance_key_limits l ON l.key_id = k.key_id
    WHERE k.wallet_address = ? AND k.scope = 'allowance'
    ORDER BY k.created_at DESC
  `).all(owner) as (LimitsRow & { key_id: string; key_prefix: string; label: string | null; created_at: string; last_used_at: string | null })[];
  return rows.map((r) => ({
    keyId: r.key_id,
    keyPrefix: r.key_prefix,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    ...toLimits(r),
    spentTodayWei: keySpentTodayWei(r.key_id),
  }));
}

/** One-click revoke. Only the wallet that owns the key can do it; a revoked key stops working at once. */
export function revokeAllowanceKey(keyId: string, walletAddress: string): boolean {
  const revoked = revokeApiKeyById(keyId, walletAddress);
  if (revoked) getDb().prepare("DELETE FROM allowance_key_limits WHERE key_id = ?").run(keyId);
  return revoked;
}
