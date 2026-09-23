// The share of an $AXON payment that never comes back.
//
// Different from the pot, and deliberately kept apart from it. The pot takes ETH, buys $AXON on the
// market, and burns what it bought, so every burn there is a purchase anyone can see. This does not
// buy anything: the payment already arrived in the token, and a share of it simply stops existing.
//
// Because they are different mechanisms, they are counted separately. Folding them into one figure
// would make the burn page's number mean two things at once, and it currently means one thing that
// can be checked against the chain.
//
// Timing is the part worth being careful about. An obligation is created when a payment is escrowed
// but is only due once that payment completes, and is dead if it is refunded. Burning out of a
// refunded payment would be taking ten percent of somebody's money because their task failed.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";

export const BPS = 10_000;

/**
 * The share of a payment that burns, in basis points.
 *
 * Ten percent by default, and configurable because the right number is a decision about the economy
 * rather than about the code. Starting low is the cautious direction: raising a burn share is an
 * announcement, lowering one is an explanation.
 */
export const BURN_BPS = (() => {
  const raw = Number(process.env.AXON_PAYMENT_BURN_BPS);
  if (!Number.isInteger(raw) || raw < 0) return 1_000;
  return Math.min(raw, MAX_BURN_BPS());
})();

/**
 * Nothing may burn more than a third of a payment.
 *
 * Not an economic view, a guard against a typo. Basis points make 3000 and 30000 look similar enough
 * that one of them would eventually be typed, and without a ceiling that one would burn the agent's
 * entire fee and then some.
 */
function MAX_BURN_BPS(): number {
  return 3_333;
}

export interface BurnShares {
  /** what the payer sent */
  paid: bigint;
  /** what the agent is owed */
  toAgent: bigint;
  /** what stops existing */
  toBurn: bigint;
}

/**
 * Split a payment into the agent's part and the burned part.
 *
 * The burn rounds DOWN and the agent takes the remainder, so the two always sum back to exactly what
 * was paid. Rounding the other way would, over enough payments, burn units that were never sent.
 */
export function splitPayment(paid: bigint, bps: number = BURN_BPS): BurnShares {
  if (paid <= 0n) return { paid: 0n, toAgent: 0n, toBurn: 0n };
  const toBurn = (paid * BigInt(bps)) / BigInt(BPS);
  return { paid, toAgent: paid - toBurn, toBurn };
}

export interface BurnObligation {
  burnId: string;
  txId: string;
  quoteId: string | null;
  paidUnits: bigint;
  burnUnits: bigint;
  burnBps: number;
  createdAt: string;
  burnedAt: string | null;
  burnTx: string | null;
}

interface Row {
  burn_id: string; tx_id: string; quote_id: string | null; paid_units: string;
  burn_units: string; burn_bps: number; created_at: string; burned_at: string | null; burn_tx: string | null;
}

const hydrate = (r: Row): BurnObligation => ({
  burnId: r.burn_id,
  txId: r.tx_id,
  quoteId: r.quote_id,
  paidUnits: BigInt(r.paid_units),
  burnUnits: BigInt(r.burn_units),
  burnBps: r.burn_bps,
  createdAt: r.created_at,
  burnedAt: r.burned_at,
  burnTx: r.burn_tx,
});

const COLS = `burn_id, tx_id, quote_id, paid_units, burn_units, burn_bps, created_at, burned_at, burn_tx`;

/** Written when the payment is escrowed. Due later, or never, depending on how the task ends. */
export function recordObligation(opts: {
  txId: string;
  quoteId?: string | null;
  paid: bigint;
  burn: bigint;
  bps?: number;
}): BurnObligation {
  const row: BurnObligation = {
    burnId: randomUUID(),
    txId: opts.txId,
    quoteId: opts.quoteId ?? null,
    paidUnits: opts.paid,
    burnUnits: opts.burn,
    burnBps: opts.bps ?? BURN_BPS,
    createdAt: new Date().toISOString(),
    burnedAt: null,
    burnTx: null,
  };

  getDb()
    .prepare(`INSERT INTO axon_payment_burns (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
    .run(row.burnId, row.txId, row.quoteId, row.paidUnits.toString(), row.burnUnits.toString(), row.burnBps, row.createdAt);

  return row;
}

export function obligationFor(txId: string): BurnObligation | null {
  const row = getDb().prepare(`SELECT ${COLS} FROM axon_payment_burns WHERE tx_id = ?`).get(txId) as Row | undefined;
  return row ? hydrate(row) : null;
}

/**
 * What is owed to nobody and has not been sent there yet.
 *
 * Joined against the payment's own status rather than carrying a status of its own. A payment that is
 * still in escrow has not earned its burn, and one that was refunded never will: the payer got their
 * money back, and burning a tenth of it because their task failed would be taking it from them.
 */
export function dueBurns(limit = 100): BurnObligation[] {
  return (
    getDb()
      .prepare(
        `SELECT b.burn_id, b.tx_id, b.quote_id, b.paid_units, b.burn_units, b.burn_bps,
                b.created_at, b.burned_at, b.burn_tx
           FROM axon_payment_burns b
           JOIN transactions t ON t.tx_id = b.tx_id
          WHERE b.burned_at IS NULL
            AND t.status = 'completed'
          ORDER BY b.created_at ASC
          LIMIT ?`,
      )
      .all(limit) as Row[]
  ).map(hydrate);
}

/** Everything still waiting on its task to finish one way or the other. */
export function pendingUnits(): bigint {
  const rows = getDb()
    .prepare(
      `SELECT b.burn_units FROM axon_payment_burns b
         JOIN transactions t ON t.tx_id = b.tx_id
        WHERE b.burned_at IS NULL AND t.status = 'escrow'`,
    )
    .all() as { burn_units: string }[];
  return rows.reduce((sum, r) => sum + BigInt(r.burn_units), 0n);
}

/** What has actually been destroyed by this mechanism. Separate from the pot's total, on purpose. */
export function burnedUnits(): bigint {
  const rows = getDb()
    .prepare("SELECT burn_units FROM axon_payment_burns WHERE burned_at IS NOT NULL")
    .all() as { burn_units: string }[];
  return rows.reduce((sum, r) => sum + BigInt(r.burn_units), 0n);
}

/** Records that an obligation was met, and by which transaction. */
export function markBurned(burnId: string, burnTx: string): boolean {
  const res = getDb()
    .prepare("UPDATE axon_payment_burns SET burned_at = ?, burn_tx = ? WHERE burn_id = ? AND burned_at IS NULL")
    .run(new Date().toISOString(), burnTx, burnId);
  return res.changes > 0;
}
