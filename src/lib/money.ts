// Amounts, and whether one was actually paid.
//
// One currency: the chain's native ETH. Everything priced, escrowed, split, capped or settled is
// an ETH amount, and the exact unit underneath is wei.
//
// The rule this file exists to enforce: a decimal is for reading, wei is for arithmetic. A price is
// parsed to wei ONCE, from its text, and every later comparison, division and on-chain check uses
// those wei. Nothing multiplies or divides a floating-point ETH amount, because the errors there do
// not throw — they pay the wrong person, or refuse someone who paid in full.

import { verifyTransfer, PAYMENT_RECEIVER_WALLET_ADDRESS } from "./evm";

export { PAYMENT_RECEIVER_WALLET_ADDRESS };

export const CURRENCY = "ETH" as const;
export type Currency = typeof CURRENCY;

/** Wei per whole ETH. */
export const WEI_PER_ETH = 10n ** 18n;
export const ETH_DECIMALS = 18;

/** An ERC-20 to settle in instead, if one is ever configured. Unset means native ETH only. */
export const TOKEN_ADDRESS = process.env.AXON_TOKEN_ADDRESS?.trim() ?? "";

export interface ParsedPayment {
  /** the human-readable amount, for display and for reporting. Never for arithmetic. */
  amount: number;
  currency: Currency;
  /** the exact amount. This is what every comparison and division uses. */
  wei: bigint;
}

// ── Decimal text ↔ wei ────────────────────────────────────────────────────────

/**
 * Exact conversion, done on the DIGITS rather than on a float.
 *
 * `Number(raw) * 1e18` would be wrong for most inputs: 0.1 has no exact binary representation, and
 * the product lands near but not on the intended wei. Splitting the string at the point and padding
 * the fraction gives the exact integer every time.
 */
export function decimalToWei(raw: string, decimals = ETH_DECIMALS): bigint | null {
  const t = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null; // more precision than the chain has; refuse rather than round
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Wei as a decimal ETH string, with no trailing zeroes and no exponent. */
export function weiToDecimalString(wei: bigint, decimals = ETH_DECIMALS): string {
  const negative = wei < 0n;
  const v = negative ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Wei as a JS number of ETH, for display and reporting only.
 *
 * Lossy past ~15 significant digits, which is exactly why nothing downstream may compute with it.
 */
export function weiToEth(wei: bigint): number {
  return Number(weiToDecimalString(wei));
}

/**
 * A number or numeric string as exact wei.
 *
 * Numbers arrive from JSON bodies and old rows, so they have to be accepted, but they are converted
 * through their decimal text rather than by multiplication. A number carrying more than 18 decimals
 * of significance cannot be honoured exactly and is refused.
 */
export function toWei(amount: unknown): bigint | null {
  if (typeof amount === "bigint") return amount >= 0n ? amount : null;
  const raw =
    typeof amount === "number"
      ? Number.isFinite(amount)
        ? decimalTextFromNumber(amount)
        : null
      : typeof amount === "string"
        ? amount.trim()
        : null;
  if (raw === null) return null;
  return decimalToWei(raw);
}

/**
 * A number's decimal text, without exponent notation.
 *
 * `String(n)` is the right source: it gives the SHORTEST decimal that round-trips to the same
 * double, which is the number as it was written. `toFixed(18)` looks more precise and is worse —
 * it prints the double's own error, turning 0.05 into 0.050000000000000003 and charging three wei
 * more than anybody asked for. The only thing left to handle is that `String` switches to exponent
 * notation for small values, which is not a decimal at all.
 */
function decimalTextFromNumber(n: number): string | null {
  if (!Number.isFinite(n) || n < 0) return null;
  const s = String(n);
  if (!/e/i.test(s)) return s;

  const m = s.match(/^(\d+)(?:\.(\d+))?e([+-]\d+)$/i);
  if (!m) return null;
  const [, whole, frac = "", expRaw] = m;
  const exp = Number(expRaw);
  const digits = whole + frac;
  if (exp < 0) {
    const zeros = -exp - whole.length;
    return zeros >= 0 ? `0.${"0".repeat(zeros)}${digits}` : `${digits.slice(0, -(-exp))}.${digits.slice(-(-exp))}`;
  }
  const pad = exp - frac.length;
  return pad >= 0 ? digits + "0".repeat(pad) : `${digits.slice(0, whole.length + exp)}.${digits.slice(whole.length + exp)}`;
}

// ── Prices ────────────────────────────────────────────────────────────────────

/** Parses "0.05 ETH". Returns null if unrecognised or not positive. */
export function parsePaymentAmount(price: string): ParsedPayment | null {
  const m = price.trim().match(/^(\d+(?:\.\d+)?)\s*ETH$/i);
  if (!m) return null;
  const wei = decimalToWei(m[1]);
  if (wei === null || wei <= 0n) return null;
  return { amount: Number(m[1]), currency: CURRENCY, wei };
}

/** An amount given as a bare number or string, with no currency word attached. */
export function parseAmount(amount: unknown): { amount: number; wei: bigint } | null {
  const wei = toWei(amount);
  if (wei === null || wei <= 0n) return null;
  return { amount: weiToEth(wei), wei };
}

/** How an amount is written for a person: "0.05 ETH". */
export function formatEth(value: bigint | number): string {
  const wei = typeof value === "bigint" ? value : toWei(value);
  return `${wei === null ? "0" : weiToDecimalString(wei)} ETH`;
}

// ── Verifying an incoming payment ─────────────────────────────────────────────

/** Thin boolean wrapper, for callers that only need yes or no. */
export async function verifyIncomingPayment(
  signature: string,
  expected: ParsedPayment,
  expectedSigner?: string,
): Promise<boolean> {
  return (await checkIncomingPayment(signature, expected, expectedSigner)).ok;
}

/**
 * Did this transaction pay the treasury what was owed?
 *
 * `expected.wei` is used as it stands. It came from the price text and has not been through a float
 * since, so what is compared on-chain is exactly what was quoted.
 */
export async function checkIncomingPayment(
  signature: string,
  expected: ParsedPayment,
  expectedSigner?: string,
): Promise<{ ok: boolean; reason: string }> {
  if (!PAYMENT_RECEIVER_WALLET_ADDRESS) {
    throw new Error("PAYMENT_RECEIVER_WALLET_ADDRESS is not set");
  }

  if (process.env.AXON_PAYMENT_VERIFIER === "mock") {
    const ok = verifyMockIncomingPayment(signature, expected, expectedSigner);
    return { ok, reason: ok ? "ok" : "mock verification failed" };
  }

  if (expected.wei <= 0n) return { ok: false, reason: "expected payment amount is invalid" };

  return verifyTransfer({
    txHash: signature,
    to: PAYMENT_RECEIVER_WALLET_ADDRESS,
    minValue: expected.wei,
    ...(TOKEN_ADDRESS ? { token: TOKEN_ADDRESS } : {}),
    from: expectedSigner,
  });
}

// The test lane. `mockpay:CURRENCY:WEI:SIGNER:RECEIVER:NONCE` stands in for a real transaction so
// the paid routes can be exercised end to end without a chain.
function verifyMockIncomingPayment(
  signature: string,
  expected: ParsedPayment,
  expectedSigner?: string,
): boolean {
  const parts = signature.split(":");
  if (parts.length !== 6 || parts[0] !== "mockpay") return false;

  const [, currency, weiRaw, signer, receiver] = parts;
  if (currency !== expected.currency) return false;
  if (expectedSigner && signer !== expectedSigner) return false;
  if (receiver !== PAYMENT_RECEIVER_WALLET_ADDRESS) return false;

  try {
    return BigInt(weiRaw) >= expected.wei;
  } catch {
    return false;
  }
}
