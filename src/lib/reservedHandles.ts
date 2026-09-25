import { getDb } from "./db";
import { getTier, type TierName } from "./holderTier";
import { normalizeAddress, sameAddress } from "./address";
import { agentExists } from "./agents";

// Names held for later.
//
// An agent id is permanent and first come, first served. It ends up in every receipt, every
// passport and every URL that agent will ever have, and somebody planning to publish next month has
// no way to hold the name they have already told people about.
//
// Reserving one costs the network nothing — it is a row saying a string is spoken for — which makes
// it the right shape for a tier benefit: real scarcity, no spend. Base holds none, which is exactly
// today's behaviour, so nothing is taken from anyone.

/** Reservations a tier may hold at once. Base is zero: this is a benefit, not a right. */
export const HANDLES_BY_TIER: Record<TierName, number> = {
  base: 0,
  holder: 1,
  builder: 3,
  operator: 10,
};

export interface Reservation {
  handle: string;
  wallet: string;
  tierAtClaim: string;
  createdAt: string;
}

interface Row {
  handle: string;
  wallet: string;
  tier_at_claim: string;
  created_at: string;
}

const toReservation = (r: Row): Reservation => ({
  handle: r.handle,
  wallet: r.wallet,
  tierAtClaim: r.tier_at_claim,
  createdAt: r.created_at,
});

/** Ids are compared lowercased everywhere else; a reservation matching one spelling protects nothing. */
const key = (handle: string): string => handle.trim().toLowerCase();

export function getReservation(handle: string): Reservation | null {
  const row = getDb().prepare("SELECT * FROM reserved_handles WHERE handle = ?").get(key(handle)) as Row | undefined;
  return row ? toReservation(row) : null;
}

export function reservationsFor(wallet: string): Reservation[] {
  const owner = normalizeAddress(wallet);
  if (!owner) return [];
  return (
    getDb().prepare("SELECT * FROM reserved_handles WHERE wallet = ? ORDER BY created_at DESC").all(owner) as Row[]
  ).map(toReservation);
}

/**
 * May this wallet register under this id?
 *
 * Yes when nobody has reserved it, and yes when the reservation is their own. A reservation is a
 * hold against everyone else, never against the person holding it.
 */
export function canRegister(handle: string, wallet: string | null | undefined): boolean {
  const held = getReservation(handle);
  if (!held) return true;
  return sameAddress(held.wallet, wallet ?? undefined);
}

export type ClaimResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: string };

/**
 * Claim a name.
 *
 * Refuses a name already registered as an agent: reserving something that exists would be selling a
 * hold on a thing somebody else already has.
 */
export async function claimHandle(handle: string, wallet: string): Promise<ClaimResult> {
  const owner = normalizeAddress(wallet);
  if (!owner) return { ok: false, reason: "wallet must be a 0x address" };

  const h = key(handle);
  if (!h) return { ok: false, reason: "handle is required" };

  if (agentExists(h)) return { ok: false, reason: `'${h}' is already a registered agent` };

  const existing = getReservation(h);
  if (existing) {
    return sameAddress(existing.wallet, owner)
      ? { ok: true, reservation: existing } // idempotent: claiming your own again is not an error
      : { ok: false, reason: `'${h}' is already reserved` };
  }

  const { tier } = await getTier(owner);
  const allowance = HANDLES_BY_TIER[tier.name] ?? 0;
  if (allowance === 0) {
    return { ok: false, reason: "reserving a handle needs $AXON. See axon-agents.com/tier" };
  }

  const held = reservationsFor(owner).length;
  if (held >= allowance) {
    return { ok: false, reason: `your tier holds ${allowance} reservation${allowance === 1 ? "" : "s"}, release one first` };
  }

  const createdAt = new Date().toISOString();
  getDb()
    .prepare("INSERT INTO reserved_handles (handle, wallet, tier_at_claim, created_at) VALUES (?, ?, ?, ?)")
    .run(h, owner, tier.name, createdAt);

  return { ok: true, reservation: { handle: h, wallet: owner, tierAtClaim: tier.name, createdAt } };
}

/** Give one up. Only the wallet holding it can, and releasing one you do not hold is not an error. */
export function releaseHandle(handle: string, wallet: string): boolean {
  const owner = normalizeAddress(wallet);
  if (!owner) return false;
  const held = getReservation(handle);
  if (!held || !sameAddress(held.wallet, owner)) return false;

  getDb().prepare("DELETE FROM reserved_handles WHERE handle = ?").run(key(handle));
  return true;
}

/**
 * Clear a reservation the owner has just used.
 *
 * Registering the agent is the reservation's whole purpose, so holding the row afterwards would
 * count a spent reservation against their allowance forever.
 */
export function consumeHandle(handle: string, wallet: string | null | undefined): void {
  const held = getReservation(handle);
  if (held && sameAddress(held.wallet, wallet ?? undefined)) {
    getDb().prepare("DELETE FROM reserved_handles WHERE handle = ?").run(key(handle));
  }
}
