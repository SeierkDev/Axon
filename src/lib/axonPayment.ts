// Turning a paid quote into a payment, and making sure a refund comes back in what was paid.
//
// The ledger already carries a currency on every row, and release and refund both read it rather than
// assuming, so a row denominated in $AXON settles and reverses in $AXON without either path being
// taught anything new. What did not exist was a way to write such a row in the first place. This is
// that, and nothing else: the money paths that genuinely assume ETH are refused here rather than
// quietly handed an amount in another denomination.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { settleQuote, getQuote, type SettleFailure } from "./axonQuote";
import { getSplitsForTask } from "./escrowSplits";
import { getSlaForTask } from "./sla";
import { getBudget } from "./budgets";
import { getAgentById } from "./agents";
import { splitPayment, recordObligation, obligationFor } from "./axonBurn";
import { logger } from "./logger";

/** The denomination an $AXON row carries. Never "ETH", so no ETH total can pick it up. */
export const AXON_CURRENCY = "AXON" as const;

export type AxonPaymentFailure =
  | SettleFailure
  | "signature-already-used"
  | "task-has-splits"
  | "task-has-sla"
  | "payer-has-budget"
  | "agent-does-not-accept-axon";

export interface AxonPayment {
  txId: string;
  taskId: string | null;
  fromAgent: string;
  toAgent: string;
  /** what the agent is owed, in whole $AXON as a decimal string */
  amount: string;
  /** what the payer sent, before the burned share was taken out */
  paidAmount: string;
  /** the part that stops existing, once this payment completes */
  burnAmount: string;
  currency: typeof AXON_CURRENCY;
  quoteId: string;
  txHash: string;
}

/** Eighteen decimals, rendered without a float touching it. Display only. */
function unitsToDecimal(units: bigint): string {
  const whole = units / 10n ** 18n;
  const frac = (units % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Escrow an $AXON payment against a quote that has been paid.
 *
 * The amount escrowed is the quote's pinned amount, never a recomputed one, for the same reason
 * verification checks the pinned amount: the payer is owed exactly what they were shown.
 *
 * Refusals here are deliberate rather than defensive. Splits divide an escrow by share, budgets are
 * ETH-denominated caps, and both would be handed a number in the wrong unit. Refusing is honest;
 * dividing 9,178 $AXON against a 0.5 ETH cap is not.
 */
export async function createAxonPayment(opts: {
  taskId?: string;
  fromAgent: string;
  toAgent: string;
  quoteId: string;
  txHash: string;
  payerWallet?: string;
}): Promise<{ ok: true; payment: AxonPayment } | { ok: false; reason: AxonPaymentFailure; detail?: string }> {
  const db = getDb();

  const already = db
    .prepare("SELECT 1 FROM transactions WHERE incoming_signature = ?")
    .get(opts.txHash);
  if (already) return { ok: false, reason: "signature-already-used" };

  if (opts.taskId && getSplitsForTask(opts.taskId).length > 0) {
    return { ok: false, reason: "task-has-splits" };
  }
  // Refused when the SLA is agreed rather than when the penalty is applied. The proportional split
  // itself would survive another eighteen-decimal unit, but a task that cannot be settled cleanly
  // should never be entered into, and finding that out at settlement is finding out too late.
  if (opts.taskId && getSlaForTask(opts.taskId)) {
    return { ok: false, reason: "task-has-sla" };
  }
  // A budget is a cap in ETH. Drawing an $AXON amount against it would compare two different units
  // and let a payer spend far past their limit, or nothing at all, depending which way the rate sat.
  if (getBudget(opts.fromAgent)) {
    return { ok: false, reason: "payer-has-budget" };
  }
  // The worker's own terms. Escrowing a token payment for an agent that never opted in would commit
  // its owner to being paid in something they did not agree to take.
  if (!getAgentById(opts.toAgent)?.acceptsAxon) {
    return { ok: false, reason: "agent-does-not-accept-axon" };
  }

  const settled = await settleQuote({
    quoteId: opts.quoteId,
    txHash: opts.txHash,
    ...(opts.payerWallet ? { payer: opts.payerWallet } : {}),
  });
  if (!settled.ok) return { ok: false, reason: settled.reason, detail: settled.detail };

  // The agent is owed the payment less the burned share. The obligation is written alongside, but is
  // not due yet: it becomes due only if this payment completes, and dies if it is refunded, because
  // burning out of a refund would take a tenth of somebody's money for a task that failed.
  const shares = splitPayment(settled.quote.axonUnits);
  const units = shares.toAgent;
  const amount = unitsToDecimal(units);
  const txId = randomUUID();
  const createdAt = new Date().toISOString();

  try {
    // Both columns on purpose. amount_eth is a REAL and every aggregate and display already reads it,
    // but a double keeps only the first sixteen digits, and an $AXON amount has more than that. The
    // exact integer goes in beside it, so the ledger can still say precisely what the chain moved.
    db.prepare(
      `INSERT INTO transactions
         (tx_id, task_id, from_agent, to_agent, amount_eth, amount_units, status, incoming_signature, fee_amount, currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'escrow', ?, 0, ?, ?)`,
    ).run(txId, opts.taskId ?? null, opts.fromAgent, opts.toAgent, amount, units.toString(), opts.txHash, AXON_CURRENCY, createdAt);
  } catch (err) {
    // The quote is already consumed at this point and the chain already moved. Losing the row would
    // strand a real payment, so it is worth being loud about rather than swallowing.
    logger.error("payment.axon_insert_failed", "An $AXON payment verified on-chain but did not record", {
      err, quoteId: opts.quoteId, txHash: opts.txHash,
    });
    throw err;
  }

  if (shares.toBurn > 0n) {
    recordObligation({ txId, quoteId: opts.quoteId, paid: shares.paid, burn: shares.toBurn });
  }

  logger.info("payment.axon_created", "Payment verified and escrowed in $AXON", {
    txId, taskId: opts.taskId ?? null, quoteId: opts.quoteId, amount,
    burnUnits: shares.toBurn.toString(),
  });

  return {
    ok: true,
    payment: {
      txId,
      taskId: opts.taskId ?? null,
      fromAgent: opts.fromAgent,
      toAgent: opts.toAgent,
      amount,
      paidAmount: unitsToDecimal(shares.paid),
      burnAmount: unitsToDecimal(shares.toBurn),
      currency: AXON_CURRENCY,
      quoteId: opts.quoteId,
      txHash: opts.txHash,
    },
  };
}

/** The quote a payment came from, so a refund can be explained in the terms it was agreed in. */
export function quoteForPayment(txHash: string) {
  const row = getDb()
    .prepare("SELECT quote_id FROM axon_quotes WHERE tx_hash = ?")
    .get(txHash) as { quote_id: string } | undefined;
  return row ? getQuote(row.quote_id) : null;
}

/** Is this ledger row denominated in something other than the reporting currency. */
export const isAxonRow = (currency: string | null | undefined): boolean => currency === AXON_CURRENCY;

/**
 * What the payer is owed back if this payment is refunded.
 *
 * Not the escrowed amount. That is the agent's share, with the burned part already taken out, and a
 * payer whose task failed is owed everything they sent rather than ninety percent of it. The burn
 * never happened: an obligation only becomes due once its payment completes.
 */
export function refundableUnits(txId: string): bigint | null {
  const escrowed = exactUnits(txId);
  if (escrowed === null) return null;
  return escrowed + (obligationFor(txId)?.burnUnits ?? 0n);
}

/**
 * The exact amount escrowed for the agent, in the token's own units.
 *
 * Read from amount_units rather than amount_eth, because the latter is a double and an $AXON amount
 * does not fit in one. Null for an ETH row, where amount_eth is already exact enough.
 */
export function exactUnits(txId: string): bigint | null {
  const row = getDb()
    .prepare("SELECT amount_units FROM transactions WHERE tx_id = ?")
    .get(txId) as { amount_units: string | null } | undefined;
  if (!row?.amount_units) return null;
  try {
    return BigInt(row.amount_units);
  } catch {
    return null;
  }
}
