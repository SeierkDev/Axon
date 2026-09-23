import { getAddress, isAddress } from "viem";

/**
 * One spelling of an address, everywhere.
 *
 * MetaMask hands back a checksummed address (mixed case), while an address typed by hand or
 * copied out of an explorer may arrive in any case at all. Every comparison in this codebase is a
 * string comparison against a stored value, so two spellings of the same account would read as two
 * different owners: registration would be refused, and an agent's owner check would fail against
 * the very wallet that created it. Storing and comparing one spelling is what stops that.
 *
 * Lowercase is the stored form. Checksummed is for display only.
 */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: false })) return null;
  return trimmed.toLowerCase();
}

/**
 * True when two values name the same owner, whatever case either arrived in.
 *
 * This replaces `===` at every authorization check, so it must never say "different" where `===`
 * said "same". When both sides are real addresses it compares them normalized, which is the whole
 * point. When either is not an address it falls back to exact equality, so identifiers that are
 * not addresses at all still match themselves and a guard built on this cannot quietly stop
 * guarding.
 */
export function sameAddress(a: unknown, b: unknown): boolean {
  const left = normalizeAddress(a);
  const right = normalizeAddress(b);
  if (left !== null && right !== null) return left === right;
  return typeof a === "string" && typeof b === "string" && a.trim() !== "" && a.trim() === b.trim();
}

/** The checksummed spelling, for anything a person reads. Returns null if it isn't an address. */
function displayAddress(value: unknown): string | null {
  const normalized = normalizeAddress(value);
  return normalized ? getAddress(normalized) : null;
}

/** 0x1234…abcd, for tight spaces. */
export function shortAddress(value: unknown): string | null {
  const display = displayAddress(value);
  return display ? `${display.slice(0, 6)}…${display.slice(-4)}` : null;
}

/** True when the value is a well-formed EVM address, in any case. */
export function isWalletAddress(value: unknown): boolean {
  return normalizeAddress(value) !== null;
}
