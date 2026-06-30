// Phase 10 (10.5): per-wallet avatar persistence for Axon World.
//
// Cosmetic only — the colours of a visitor's low-poly character. Validated and
// stored keyed by wallet address. No signing (nothing of value is at stake); a
// signature gate can be added later if griefing ever becomes a concern.

import { getDb } from "./db";

export interface WorldAvatar {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  hat: string;
  hairStyle: string;
  hatStyle: string;
  name: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
// Solana base58 addresses are 32–44 chars.
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HAIR_STYLES = new Set(["none", "short", "ponytail", "bun", "spiky"]);
const HAT_STYLES = new Set(["none", "cowboy", "cap", "beanie", "bucket"]);

export function isValidWallet(wallet: string): boolean {
  return WALLET.test(wallet);
}

// Coerce arbitrary input into a valid avatar, or null if anything is off.
export function parseAvatar(input: unknown): WorldAvatar | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const need = (v: unknown): v is string => typeof v === "string" && HEX.test(v);
  if (!need(o.skin) || !need(o.hair) || !need(o.shirt) || !need(o.pants) || !need(o.hat)) return null;
  const pick = (v: unknown, set: Set<string>, dflt: string) => (typeof v === "string" && set.has(v) ? v : dflt);
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 20) || null : null;
  return {
    skin: o.skin,
    hair: o.hair,
    shirt: o.shirt,
    pants: o.pants,
    hat: o.hat,
    hairStyle: pick(o.hairStyle, HAIR_STYLES, "short"),
    hatStyle: pick(o.hatStyle, HAT_STYLES, "none"),
    name,
  };
}

export function getAvatar(wallet: string): WorldAvatar | null {
  const row = getDb()
    .prepare(`SELECT skin, hair, shirt, pants, hat, hair_style AS hairStyle, hat_style AS hatStyle, name FROM world_avatars WHERE wallet = ?`)
    .get(wallet) as WorldAvatar | undefined;
  return row ?? null;
}

export function saveAvatar(wallet: string, a: WorldAvatar): void {
  getDb()
    .prepare(
      `INSERT INTO world_avatars (wallet, skin, hair, shirt, pants, hat, hair_style, hat_style, name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(wallet) DO UPDATE SET
         skin = excluded.skin, hair = excluded.hair, shirt = excluded.shirt,
         pants = excluded.pants, hat = excluded.hat, hair_style = excluded.hair_style,
         hat_style = excluded.hat_style, name = excluded.name, updated_at = datetime('now')`
    )
    .run(wallet, a.skin, a.hair, a.shirt, a.pants, a.hat, a.hairStyle, a.hatStyle, a.name);
}
