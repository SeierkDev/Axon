// Quoting a job in $AXON, and checking that the quote is what arrived.
//
// The shape of the problem: the agent prices in ETH, the payer sends $AXON, and the rate between them
// moves. Everything here exists to make sure the number a payer is shown is the number they are held
// to, and that a payment cannot be counted twice.
//
// Off by default. A quote cannot be issued unless AXON_SETTLEMENT_TOKEN_ADDRESS is set, so the whole
// path ships dark and is turned on deliberately rather than by a variable someone set for a gate.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { SETTLEMENT_TOKEN_ADDRESS, PAYMENT_RECEIVER_WALLET_ADDRESS } from "./money";
import { readPoolPrice, axonForWei } from "./axonPool";
import { verifyTransfer } from "./evm";

/** Long enough to sign and land a transaction, short enough that the rate cannot wander far. */
export const QUOTE_TTL_SECONDS = 600;

/**
 * Nothing below this is quotable, in ETH terms.
 *
 * A job priced at a fraction of a cent costs more in gas than it pays, and the rounding below starts
 * to matter relative to the amount. Agents list from 0.00005 ETH, so this refuses only what was
 * already nonsense.
 */
export const MIN_QUOTE_WEI = 10_000_000_000_000n; // 0.00001 ETH

/**
 * How far a new quote may sit from the last one before it is refused, in basis points.
 *
 * The pool is thin, so its price can be pushed. This does not stop that, and nothing here can: it
 * bounds how much a push is worth by refusing to quote through a sudden move, so an attacker has to
 * hold the price across the window rather than flash it for one block.
 */
export const MAX_DEVIATION_BPS = 2_000; // 20%

/**
 * How old the quote being compared against may be before it stops counting.
 *
 * Without this the guard eats itself. The reference is the last quote ever issued, and a refused
 * quote is never written, so once the live price sits further than the deviation from that last
 * quote, nothing can be quoted, which means the reference can never move, which means nothing can
 * ever be quoted again. The token option does not pause, it disappears, and only a hand-written row
 * brings it back. Busy hours hide this, because each quote nudges the reference along in small
 * steps. A quiet night and one real move is all it takes.
 *
 * An hour leaves the guard doing its actual job, refusing to quote through a sudden move, while
 * letting a move that genuinely happened over hours become the new normal. A flash lasts seconds.
 */
export const REFERENCE_MAX_AGE_SECONDS = 60 * 60;

export interface AxonQuote {
  quoteId: string;
  reference: string | null;
  ethWei: bigint;
  axonUnits: bigint;
  sqrtPriceX96: bigint;
  payTo: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  txHash: string | null;
}

export type QuoteFailure =
  | "settlement-disabled"
  | "no-receiver"
  | "below-minimum"
  | "no-price"
  | "rate-moved";

export const axonPaymentsEnabled = (): boolean => Boolean(SETTLEMENT_TOKEN_ADDRESS);

/**
 * Anything outside the allowed range is no discount at all, rather than the nearest legal value.
 * A number that was typed wrong should not quietly become a real offer just because it was close to
 * one, and half is already generous enough that the cap only ever catches a mistake.
 */
export const MAX_DISCOUNT_BPS = 5_000;
export function clampDiscountBps(raw: number | undefined): number {
  if (raw === undefined) return 0;
  return Number.isInteger(raw) && raw > 0 && raw <= MAX_DISCOUNT_BPS ? raw : 0;
}

interface Row {
  quote_id: string; reference: string | null; eth_wei: string; axon_units: string;
  sqrt_price_x96: string; pay_to: string; created_at: string; expires_at: string;
  consumed_at: string | null; tx_hash: string | null;
}

const hydrate = (r: Row): AxonQuote => ({
  quoteId: r.quote_id,
  reference: r.reference,
  ethWei: BigInt(r.eth_wei),
  axonUnits: BigInt(r.axon_units),
  sqrtPriceX96: BigInt(r.sqrt_price_x96),
  payTo: r.pay_to,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  consumedAt: r.consumed_at,
  txHash: r.tx_hash,
});

const SELECT = `SELECT quote_id, reference, eth_wei, axon_units, sqrt_price_x96, pay_to,
                       created_at, expires_at, consumed_at, tx_hash
                  FROM axon_quotes`;

export function getQuote(quoteId: string): AxonQuote | null {
  const row = getDb().prepare(`${SELECT} WHERE quote_id = ?`).get(quoteId) as Row | undefined;
  return row ? hydrate(row) : null;
}

/** The most recent quote, whatever became of it. Used to judge whether the rate has jumped. */
export function lastQuote(): AxonQuote | null {
  const row = getDb().prepare(`${SELECT} ORDER BY created_at DESC LIMIT 1`).get() as Row | undefined;
  return row ? hydrate(row) : null;
}

export const isExpired = (q: AxonQuote, now: Date = new Date()): boolean =>
  Date.parse(q.expiresAt) <= now.getTime();

/**
 * Issue a quote, or say why not.
 *
 * An idempotency key returns the quote it already made rather than a second one. A caller that
 * retried a request must not end up holding two live prices and paying whichever moved in its favour.
 */
export async function createQuote(opts: {
  ethWei: bigint;
  reference?: string;
  idempotencyKey?: string;
  /** What the agent knocks off for paying in the token, in basis points. */
  discountBps?: number;
}): Promise<{ ok: true; quote: AxonQuote } | { ok: false; reason: QuoteFailure }> {
  if (!axonPaymentsEnabled()) return { ok: false, reason: "settlement-disabled" };
  if (!PAYMENT_RECEIVER_WALLET_ADDRESS) return { ok: false, reason: "no-receiver" };

  // The discount is applied to the debt before it is converted, not to the token amount after. Same
  // arithmetic either way, but this order means the stored eth_wei is what the payer actually owes,
  // so a quote explains itself later without anyone needing to know a discount was ever involved.
  const discount = clampDiscountBps(opts.discountBps);
  const ethWei = discount > 0 ? (opts.ethWei * BigInt(10_000 - discount)) / 10_000n : opts.ethWei;

  if (ethWei < MIN_QUOTE_WEI) return { ok: false, reason: "below-minimum" };

  if (opts.idempotencyKey) {
    const existing = getDb()
      .prepare(`${SELECT} WHERE idempotency_key = ?`)
      .get(opts.idempotencyKey) as Row | undefined;
    if (existing) return { ok: true, quote: hydrate(existing) };
  }

  const price = await readPoolPrice();
  if (!price) return { ok: false, reason: "no-price" };

  // A sudden move is refused rather than quoted through. Compared on the sqrt price, which is what the
  // chain stores, so the comparison needs no arithmetic that could itself drift.
  const previous = lastQuote();
  const referenceAgeMs = previous ? Date.now() - Date.parse(previous.createdAt) : Infinity;
  const referenceIsCurrent = referenceAgeMs <= REFERENCE_MAX_AGE_SECONDS * 1_000;
  if (previous && previous.sqrtPriceX96 > 0n && referenceIsCurrent) {
    const a = price.sqrtPriceX96;
    const b = previous.sqrtPriceX96;
    const diff = a > b ? a - b : b - a;
    if ((diff * 10_000n) / b > BigInt(MAX_DEVIATION_BPS)) return { ok: false, reason: "rate-moved" };
  }

  const axonUnits = axonForWei(ethWei, price.sqrtPriceX96);
  if (axonUnits <= 0n) return { ok: false, reason: "no-price" };

  const now = new Date();
  const quote: AxonQuote = {
    quoteId: randomUUID(),
    reference: opts.reference ?? null,
    ethWei,
    axonUnits,
    sqrtPriceX96: price.sqrtPriceX96,
    payTo: PAYMENT_RECEIVER_WALLET_ADDRESS,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000).toISOString(),
    consumedAt: null,
    txHash: null,
  };

  getDb()
    .prepare(
      `INSERT INTO axon_quotes
         (quote_id, reference, eth_wei, axon_units, sqrt_price_x96, pay_to, created_at, expires_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      quote.quoteId, quote.reference, quote.ethWei.toString(), quote.axonUnits.toString(),
      quote.sqrtPriceX96.toString(), quote.payTo, quote.createdAt, quote.expiresAt,
      opts.idempotencyKey ?? null,
    );

  return { ok: true, quote };
}

export type SettleFailure =
  | "unknown-quote"
  | "expired"
  | "already-settled"
  | "transfer-rejected"
  | "tx-already-used";

/**
 * Was this quote paid, by this transaction.
 *
 * The amount checked is the one written down when the quote was issued, never a fresh one. That is
 * the entire reason quotes are stored: a payer who sent exactly what they were shown must not be
 * refused because the pool moved while their transaction was being mined.
 *
 * Expiry is judged before the chain is touched, so a stale quote costs nothing to reject.
 */
export async function settleQuote(opts: {
  quoteId: string;
  txHash: string;
  payer?: string;
  now?: Date;
}): Promise<{ ok: true; quote: AxonQuote } | { ok: false; reason: SettleFailure; detail?: string }> {
  const quote = getQuote(opts.quoteId);
  if (!quote) return { ok: false, reason: "unknown-quote" };
  if (quote.consumedAt) {
    // Replaying the same transaction against the same quote is a retry, not a second payment.
    return quote.txHash === opts.txHash
      ? { ok: true, quote }
      : { ok: false, reason: "already-settled" };
  }
  if (isExpired(quote, opts.now ?? new Date())) return { ok: false, reason: "expired" };

  const seen = getDb()
    .prepare("SELECT quote_id FROM axon_quotes WHERE tx_hash = ?")
    .get(opts.txHash) as { quote_id: string } | undefined;
  if (seen) return { ok: false, reason: "tx-already-used" };

  const result = await verifyTransfer({
    txHash: opts.txHash,
    to: quote.payTo,
    minValue: quote.axonUnits,
    token: SETTLEMENT_TOKEN_ADDRESS,
    ...(opts.payer ? { from: opts.payer } : {}),
  });
  if (!result.ok) return { ok: false, reason: "transfer-rejected", detail: result.reason };

  const consumedAt = new Date().toISOString();
  // Conditional on still being unconsumed, so two requests racing the same quote cannot both win.
  const wrote = getDb()
    .prepare("UPDATE axon_quotes SET consumed_at = ?, tx_hash = ? WHERE quote_id = ? AND consumed_at IS NULL")
    .run(consumedAt, opts.txHash, quote.quoteId);
  if (wrote.changes === 0) {
    const current = getQuote(quote.quoteId);
    return current?.txHash === opts.txHash
      ? { ok: true, quote: current }
      : { ok: false, reason: "already-settled" };
  }

  return { ok: true, quote: { ...quote, consumedAt, txHash: opts.txHash } };
}

/** Keeps the table from growing without limit. Called by the retention pass. */
export function pruneQuotes(keepDays = 30): number {
  try {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    return getDb().prepare("DELETE FROM axon_quotes WHERE created_at < ?").run(cutoff).changes ?? 0;
  } catch {
    return 0;
  }
}
