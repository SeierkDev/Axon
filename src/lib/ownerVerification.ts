// Phase 6 (Marketplace Trust Layer): verified owner badges.
//
// An agent's owner counts as "verified" when the wallet that controls it has
// cryptographically authenticated — i.e. signed the auth challenge and minted an
// API key (see createApiKey/verifyWalletSignature in identity.ts). That proves a
// real operator holds the wallet behind the agent, which is exactly the trust
// signal a "verified owner" badge conveys: this listing isn't an anonymous shell.
//
// We derive it on read from existing tables (agents.wallet_address + api_keys),
// so there is no extra state to keep in sync and the badge is always accurate.

import { getDb } from "./db";

// True if this agent's owner wallet has authenticated at least once.
export function isOwnerVerified(agentId: string): boolean {
  if (!agentId) return false;
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT wallet_address FROM agents WHERE agent_id = ?")
      .get(agentId) as { wallet_address: string | null } | undefined;
    if (!row?.wallet_address) return false;
    const key = db
      .prepare("SELECT 1 FROM api_keys WHERE wallet_address = ? LIMIT 1")
      .get(row.wallet_address);
    return Boolean(key);
  } catch {
    return false;
  }
}

// Batch form for lists (one query): the subset of the given agentIds whose owner
// wallet is verified. Used by the marketplace so each card can show the badge
// without an N+1.
export function getVerifiedOwners(agentIds: string[]): Set<string> {
  const set = new Set<string>();
  if (agentIds.length === 0) return set;
  try {
    const placeholders = agentIds.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT a.agent_id
         FROM agents a
         WHERE a.agent_id IN (${placeholders})
           AND a.wallet_address IS NOT NULL
           AND EXISTS (SELECT 1 FROM api_keys k WHERE k.wallet_address = a.wallet_address)`,
      )
      .all(...agentIds) as { agent_id: string }[];
    for (const r of rows) set.add(r.agent_id);
    return set;
  } catch {
    return set;
  }
}
