// Phase 10: per-wallet inventory persistence for Axon World minigame loot.
//
// Cosmetic collectibles only (fish, trophies, treasures) — validated against a
// small shape contract and stored as JSON keyed by wallet. Item ids are checked
// for shape, not against the catalog, so the catalog can grow without breaking
// older rows. No signing (nothing of monetary value at stake).

import { getDb } from "./db";
import { isValidWallet } from "./worldAvatar";

export { isValidWallet };

const MAX_DISTINCT = 64;
const MAX_COUNT = 9999;
const ID_RE = /^[a-z0-9_]{1,40}$/;

export type Inventory = Record<string, number>;

// Coerce arbitrary input into a valid inventory, or null if the shape is off.
export function parseInventory(input: unknown): Inventory | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Inventory = {};
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!ID_RE.test(k)) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
    if (v === 0) continue;
    if (++n > MAX_DISTINCT) return null;
    out[k] = Math.min(v, MAX_COUNT);
  }
  return out;
}

export function getInventory(wallet: string): Inventory {
  const row = getDb()
    .prepare("SELECT items FROM world_inventory WHERE wallet = ?")
    .get(wallet) as { items: string } | undefined;
  if (!row) return {};
  try {
    return parseInventory(JSON.parse(row.items)) ?? {};
  } catch {
    return {};
  }
}

export function saveInventory(wallet: string, items: Inventory): void {
  getDb()
    .prepare(
      `INSERT INTO world_inventory (wallet, items, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(wallet) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`,
    )
    .run(wallet, JSON.stringify(items));
}
