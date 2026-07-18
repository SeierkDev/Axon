import { randomUUID } from "crypto";
import { getDb } from "./db";
import { parsePaymentAmount, checkIncomingPayment, CircuitOpenError, isValidSolanaAddress } from "./solana";
import { queueWebhookEvent } from "./webhooks";
import { checkBudget } from "./budgets";
import { getAgentById } from "./agents";
import { logger } from "./logger";
import { syncToTurso } from "./db-turso";
import { recordRefundNote } from "./paymentNotes";
import { getSplitsForTask, computeSplitAmounts, TOTAL_BPS, type TaskSplit } from "./escrowSplits";
import { safeAppendTraceEvent, traceIdForTask } from "./traceEvents";

// 'split' marks an escrow that was settled by distribution: the original row is
// kept intact (total amount, recipient, on-chain signature) for the audit trail,
// and one 'completed' payout row is written per split recipient.
export type PaymentStatus = "escrow" | "completed" | "refunded" | "split";

// A payment error flagged transient (RPC lag, circuit open, or a tx not yet
// indexed) — the caller should retry the SAME signature rather than re-pay, so a
// payment that actually landed isn't reported as failed and charged twice.
type PaymentError = Error & { transient?: boolean };

export function isTransientPaymentError(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return true;
  if ((err as PaymentError)?.transient) return true;
  return /is not set|API_KEY|HELIUS|unavailable|timeout|rate.?limit|circuit/i.test(
    err instanceof Error ? err.message : ""
  );
}

export interface Payment {
  txId: string;
  taskId?: string;
  fromAgent: string;
  toAgent: string;
  amountSol: number;
  currency: string;
  status: PaymentStatus;
  signature?: string;
  incomingSignature?: string;
  createdAt: string;
  settledAt?: string;
}

interface PaymentRow {
  tx_id: string;
  task_id: string | null;
  from_agent: string;
  to_agent: string;
  amount_sol: number;
  fee_amount: number;
  currency: string;
  status: PaymentStatus;
  signature: string | null;
  incoming_signature: string | null;
  created_at: string;
  settled_at: string | null;
  burn_status: string | null;
}

function rowToPayment(row: PaymentRow): Payment {
  return {
    txId: row.tx_id,
    taskId: row.task_id ?? undefined,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    amountSol: row.amount_sol,
    currency: row.currency ?? "USDC",
    status: row.status,
    signature: row.signature ?? undefined,
    incomingSignature: row.incoming_signature ?? undefined,
    createdAt: row.created_at,
    settledAt: row.settled_at ?? undefined,
  };
}

function resolvePayerWallet(fromAgent: string): string | null {
  if (isValidSolanaAddress(fromAgent)) return fromAgent;
  const agent = getAgentById(fromAgent);
  return agent?.walletAddress ?? null;
}

// ── Create (escrow) ───────────────────────────────────────────────────────────

export async function createPayment(opts: {
  taskId?: string;
  fromAgent: string;
  toAgent: string;
  amountSol: number;
  paymentSignature: string;
  priceString?: string; // e.g. "5 USDC" or "0.05 SOL" — used for verification
  payerWallet?: string; // explicit payer for anonymous hires — verified on-chain as the tx signer
}): Promise<Payment> {
  const db = getDb();

  const base = parsePaymentAmount(opts.priceString ?? `${opts.amountSol} SOL`);
  if (!base) throw new Error("Payment amount must be a positive SOL or USDC amount");

  // Fast pre-check for replay and budget before hitting the Solana RPC
  const existingFast = db
    .prepare("SELECT 1 FROM transactions WHERE incoming_signature = ?")
    .get(opts.paymentSignature);
  if (existingFast) throw new Error("Payment signature already used");

  // Verify on-chain — async network call, must happen outside the SQLite transaction.
  // Attributed hires derive the payer from `from`. Anonymous hires (no account)
  // carry the payer explicitly; it's checked below as the transaction's signer, so
  // a caller can't claim a wallet that didn't actually sign the payment.
  const payerWallet =
    resolvePayerWallet(opts.fromAgent) ??
    (opts.payerWallet && isValidSolanaAddress(opts.payerWallet) ? opts.payerWallet : null);
  if (!payerWallet) {
    throw new Error("Payment payer must be a wallet address or an agent with a walletAddress");
  }

  let verification: { ok: boolean; reason: string };
  try {
    verification = await checkIncomingPayment(opts.paymentSignature, base, payerWallet);
  } catch (err) {
    // RPC outage / circuit open — the payment may well have landed on-chain, so
    // this is transient: the caller should retry the SAME signature, not re-pay.
    const e = (err instanceof Error ? err : new Error(String(err))) as PaymentError;
    e.transient = true;
    throw e;
  }
  if (!verification.ok) {
    const e = new Error(
      `Payment not verified on-chain. Expected ${base.amount.toFixed(base.currency === "USDC" ? 2 : 4)} ${base.currency} signed by ${payerWallet} (${verification.reason})`
    ) as PaymentError;
    // "Not found / not yet confirmed" can be RPC lag for a payment that did land.
    // Treat it as transient (retry the same signature) rather than a hard failure
    // — telling the caller it failed risks a double-charge when they re-pay.
    e.transient = /not found on-chain|not yet confirmed/i.test(verification.reason);
    throw e;
  }

  // Atomic write: replay check + budget check + insert in one serialized transaction.
  // This closes the race window where two concurrent requests both pass the pre-checks
  // and then both commit — the second will see the first's committed spend in the budget query.
  const txId = randomUUID();
  const createdAt = new Date().toISOString();

  db.transaction(() => {
    const existing = db
      .prepare("SELECT 1 FROM transactions WHERE incoming_signature = ?")
      .get(opts.paymentSignature);
    if (existing) throw new Error("Payment signature already used");

    if (base.currency === "USDC") {
      checkBudget(opts.fromAgent, opts.toAgent, base.amount);
    }

    db.prepare(`
      INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at)
      VALUES (?, ?, ?, ?, ?, 'escrow', ?, ?, ?, ?)
    `).run(txId, opts.taskId ?? null, opts.fromAgent, opts.toAgent, opts.amountSol, opts.paymentSignature, 0, base.currency, createdAt);
  })();

  const payment = getPaymentById(txId);
  if (!payment) throw new Error(`Failed to retrieve payment after insert: ${txId}`);
  logger.info("payment.created", "Payment verified and escrowed", {
    txId: payment.txId,
    taskId: payment.taskId,
    fromAgent: payment.fromAgent,
    toAgent: payment.toAgent,
    amount: base.amount,
    currency: base.currency,
  });
  void syncToTurso();
  return payment;
}

// ── Settle ────────────────────────────────────────────────────────────────────

export function releasePayment(taskId: string): Payment | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM transactions WHERE task_id = ? AND status = 'escrow'")
    .get(taskId) as PaymentRow | undefined;
  if (!row) return null;

  const settledAt = new Date().toISOString();

  // Multi-agent escrow split: if the payer defined a split for this task,
  // distribute the escrowed amount across the recipients by their shares.
  const splits = getSplitsForTask(taskId);
  if (splits.length > 0) {
    return releaseWithSplits(db, row, splits, settledAt);
  }

  // Platform agent payments are queued for $AXON token burn instead of going to treasury
  const toAgent = getAgentById(row.to_agent);
  const isBurn = toAgent?.verificationStatus === "platform";

  db.prepare(
    "UPDATE transactions SET status='completed', settled_at=?, burn_status=? WHERE tx_id=?"
  ).run(settledAt, isBurn ? "pending" : null, row.tx_id);

  const payment = getPaymentById(row.tx_id);
  if (!payment) throw new Error(`Payment ${row.tx_id} not found after settlement`);

  try {
    queueWebhookEvent(row.to_agent, "payment.settled", {
      txId: payment.txId,
      taskId: payment.taskId,
      fromAgent: payment.fromAgent,
      toAgent: payment.toAgent,
      amount: payment.amountSol,
      currency: payment.currency,
      settledAt: payment.settledAt,
    });
  } catch (err) {
    logger.error("webhook.queue_failed", "Failed to queue payment.settled webhook", {
      err,
      txId: payment.txId,
      taskId: payment.taskId,
      toAgent: payment.toAgent,
    });
  }

  logger.info("payment.settled", "Payment settled", {
    txId: payment.txId,
    taskId: payment.taskId,
    fromAgent: payment.fromAgent,
    toAgent: payment.toAgent,
    amount: payment.amountSol,
    currency: payment.currency,
  });

  // Flight recorder: the settlement that closes this task's trace.
  if (payment.taskId) {
    safeAppendTraceEvent({
      traceId: traceIdForTask(payment.taskId),
      taskId: payment.taskId,
      kind: "settlement.completed",
      fromAgent: payment.fromAgent,
      toAgent: payment.toAgent,
      meta: { amount: payment.amountSol, currency: payment.currency },
    });
  }

  void syncToTurso();
  return payment;
}

// Settle a split escrow: distribute the escrowed amount across recipients by
// share. The original escrow row is kept intact (its total amount, recipient,
// and on-chain incoming signature) and marked 'split' for the audit trail; each
// recipient gets a new 'completed' payout row that credits their balance. The
// payout rows sum to exactly the escrowed total, so no value is created or lost.
function releaseWithSplits(
  db: ReturnType<typeof getDb>,
  escrow: PaymentRow,
  splits: TaskSplit[],
  settledAt: string
): Payment {
  const payouts = computeSplitAmounts(escrow.amount_sol, splits);

  db.transaction(() => {
    db.prepare("UPDATE transactions SET status='split', settled_at=? WHERE tx_id=?").run(settledAt, escrow.tx_id);
    const insert = db.prepare(
      `INSERT INTO transactions
         (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at, burn_status)
       VALUES (?, ?, ?, ?, ?, 'completed', NULL, 0, ?, ?, ?, ?)`
    );
    for (const p of payouts) {
      const burn = getAgentById(p.agentId)?.verificationStatus === "platform" ? "pending" : null;
      insert.run(randomUUID(), escrow.task_id, escrow.from_agent, p.agentId, p.amount, escrow.currency, settledAt, settledAt, burn);
    }
  })();

  // Flight recorder: one settlement event for the split, carrying the escrow
  // total and how many recipients it divided across.
  if (escrow.task_id) {
    safeAppendTraceEvent({
      traceId: traceIdForTask(escrow.task_id),
      taskId: escrow.task_id,
      kind: "settlement.completed",
      fromAgent: escrow.from_agent,
      toAgent: escrow.to_agent,
      meta: { amount: escrow.amount_sol, currency: escrow.currency, splits: payouts.length },
    });
  }

  for (const p of payouts) {
    try {
      queueWebhookEvent(p.agentId, "payment.settled", {
        taskId: escrow.task_id,
        fromAgent: escrow.from_agent,
        toAgent: p.agentId,
        amount: p.amount,
        currency: escrow.currency,
        settledAt,
        split: true,
      });
    } catch (err) {
      logger.error("webhook.queue_failed", "Failed to queue split payment.settled webhook", {
        err, taskId: escrow.task_id, toAgent: p.agentId,
      });
    }
  }

  logger.info("payment.settled_split", "Escrow split settled", {
    taskId: escrow.task_id,
    recipients: payouts.length,
    total: escrow.amount_sol,
    currency: escrow.currency,
  });

  void syncToTurso();
  return getPaymentById(escrow.tx_id)!;
}

// Settle a breached SLA: the provider's payout is docked by penaltyBps and that
// portion is refunded to the client. Like releaseWithSplits, the original escrow
// row is kept intact and marked 'split' for the audit trail; the reduced payout
// is credited via 'completed' rows and a 'refunded' row records the penalty
// returned to the client. The parts sum to exactly the escrowed total, so no
// value is created or lost. If the task also has an escrow split, the reduced
// payout is distributed across the split recipients by share (so a late split
// task still pays the whole team, just less) — matching releasePayment, which
// honours splits on the on-time path. A zero penalty is a normal release; a full
// (100%) penalty is a full refund.
export function releaseWithPenalty(taskId: string, penaltyBps: number): Payment | null {
  if (penaltyBps <= 0) return releasePayment(taskId);
  if (penaltyBps >= TOTAL_BPS) return refundPayment(taskId);

  const db = getDb();
  const row = db
    .prepare("SELECT * FROM transactions WHERE task_id = ? AND status = 'escrow'")
    .get(taskId) as PaymentRow | undefined;
  if (!row) return null;

  const settledAt = new Date().toISOString();
  // Integer micro-unit math (USDC has 6 decimals) so payouts + penalty sum back
  // to exactly the escrowed total — no dust.
  const micro = Math.round(row.amount_sol * 1_000_000);
  const penaltyUnits = Math.floor((micro * penaltyBps) / TOTAL_BPS);
  const providerAmount = (micro - penaltyUnits) / 1_000_000;
  const penaltyAmount = penaltyUnits / 1_000_000;

  // Distribute the reduced payout: across the split recipients if a split exists,
  // otherwise the whole reduced amount to the single recipient.
  const splits = getSplitsForTask(taskId);
  const payouts =
    splits.length > 0
      ? computeSplitAmounts(providerAmount, splits)
      : [{ agentId: row.to_agent, amount: providerAmount }];

  db.transaction(() => {
    db.prepare("UPDATE transactions SET status='split', settled_at=? WHERE tx_id=?").run(settledAt, row.tx_id);
    const insert = db.prepare(
      `INSERT INTO transactions
         (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at, burn_status)
       VALUES (?, ?, ?, ?, ?, 'completed', NULL, 0, ?, ?, ?, ?)`
    );
    for (const p of payouts) {
      const burn = getAgentById(p.agentId)?.verificationStatus === "platform" ? "pending" : null;
      insert.run(randomUUID(), row.task_id, row.from_agent, p.agentId, p.amount, row.currency, settledAt, settledAt, burn);
    }
    // Penalty returned to the client (from_agent). A 'refunded' row documents the
    // return without crediting it as agent earnings.
    db.prepare(
      `INSERT INTO transactions
         (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at, burn_status)
       VALUES (?, ?, ?, ?, ?, 'refunded', NULL, 0, ?, ?, ?, NULL)`
    ).run(randomUUID(), row.task_id, row.to_agent, row.from_agent, penaltyAmount, row.currency, settledAt, settledAt);
  })();

  recordRefundNote(
    taskId,
    `SLA penalty: ${penaltyAmount} ${row.currency} (${penaltyBps} bps) refunded to client for late delivery`
  );

  for (const p of payouts) {
    try {
      queueWebhookEvent(p.agentId, "payment.settled", {
        taskId: row.task_id,
        fromAgent: row.from_agent,
        toAgent: p.agentId,
        amount: p.amount,
        currency: row.currency,
        settledAt,
        slaPenaltyBps: penaltyBps,
        split: splits.length > 0,
      });
    } catch (err) {
      logger.error("webhook.queue_failed", "Failed to queue SLA-penalty payment.settled webhook", {
        err,
        taskId: row.task_id,
        toAgent: p.agentId,
      });
    }
  }

  logger.warn("payment.settled_penalty", "Settled with SLA penalty", {
    taskId: row.task_id,
    recipients: payouts.length,
    penaltyBps,
    providerAmount,
    penaltyAmount,
    currency: row.currency,
  });

  // Flight recorder: the penalty-reduced settlement that closes this task's trace
  // (records what the worker actually received plus the applied penalty).
  if (row.task_id) {
    safeAppendTraceEvent({
      traceId: traceIdForTask(row.task_id),
      taskId: row.task_id,
      kind: "settlement.completed",
      fromAgent: row.from_agent,
      toAgent: row.to_agent,
      meta: { amount: providerAmount, currency: row.currency, penaltyBps },
    });
  }

  void syncToTurso();
  return getPaymentById(row.tx_id)!;
}

export function refundPayment(taskId: string): Payment | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM transactions WHERE task_id = ? AND status = 'escrow'")
    .get(taskId) as PaymentRow | undefined;
  if (!row) return null;

  const settledAt = new Date().toISOString();
  db.prepare(
    "UPDATE transactions SET status='refunded', settled_at=? WHERE tx_id=?"
  ).run(settledAt, row.tx_id);

  const payment = getPaymentById(row.tx_id);
  if (!payment) throw new Error(`Payment ${row.tx_id} not found after refund`);

  try {
    queueWebhookEvent(row.to_agent, "payment.refunded", {
      txId: payment.txId,
      taskId: payment.taskId,
      fromAgent: payment.fromAgent,
      toAgent: payment.toAgent,
      amount: payment.amountSol,
      currency: payment.currency,
      refundedAt: payment.settledAt,
    });
  } catch (err) {
    logger.error("webhook.queue_failed", "Failed to queue payment.refunded webhook", {
      err,
      txId: payment.txId,
      taskId: payment.taskId,
      toAgent: payment.toAgent,
    });
  }

  logger.warn("payment.refunded", "Payment refunded", {
    txId: payment.txId,
    taskId: payment.taskId,
    fromAgent: payment.fromAgent,
    toAgent: payment.toAgent,
    amount: payment.amountSol,
    currency: payment.currency,
  });

  // Document the refund on the receipt with the task's failure reason, so the
  // settlement explains itself instead of being a bare "refunded" status.
  const taskRow = db.prepare("SELECT error FROM tasks WHERE task_id = ?").get(taskId) as
    | { error: string | null }
    | undefined;
  recordRefundNote(taskId, taskRow?.error);

  void syncToTurso();
  return payment;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function getPaymentById(txId: string): Payment | null {
  const row = getDb()
    .prepare("SELECT * FROM transactions WHERE tx_id = ?")
    .get(txId) as PaymentRow | undefined;
  return row ? rowToPayment(row) : null;
}

export function getPaymentByTaskId(taskId: string): Payment | null {
  // A split task has one parent row (the original escrow/payment, carrying the
  // on-chain signature and full amount) plus a payout row per recipient. Prefer
  // the parent so callers see the task's actual payment, not one recipient share.
  const row = getDb()
    .prepare(
      "SELECT * FROM transactions WHERE task_id = ? ORDER BY (incoming_signature IS NULL) ASC, created_at ASC LIMIT 1"
    )
    .get(taskId) as PaymentRow | undefined;
  return row ? rowToPayment(row) : null;
}

export function getPaymentByIncomingSignature(incomingSignature: string): Payment | null {
  const row = getDb()
    .prepare("SELECT * FROM transactions WHERE incoming_signature = ?")
    .get(incomingSignature) as PaymentRow | undefined;
  return row ? rowToPayment(row) : null;
}

export function getPaymentsByAgent(agentId: string, limit = 50): Payment[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM transactions
       WHERE from_agent = ? OR to_agent = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(agentId, agentId, limit) as PaymentRow[];
  return rows.map(rowToPayment);
}

// ── Metering ──────────────────────────────────────────────────────────────────

export interface AgentBalance {
  agentId: string;
  totalEarned: number;
  totalSpent: number;
  totalEscrow: number;
  netBalance: number;
  tasksPaid: number;
}

export function getAgentBalance(agentId: string): AgentBalance {
  const db = getDb();

  const earned = (db.prepare(
    "SELECT COALESCE(SUM(amount_sol),0) AS v FROM transactions WHERE to_agent=? AND status='completed'"
  ).get(agentId) as { v: number }).v;

  const spent = (db.prepare(
    "SELECT COALESCE(SUM(amount_sol),0) AS v FROM transactions WHERE from_agent=? AND status='completed'"
  ).get(agentId) as { v: number }).v;

  const escrow = (db.prepare(
    "SELECT COALESCE(SUM(amount_sol),0) AS v FROM transactions WHERE from_agent=? AND status='escrow'"
  ).get(agentId) as { v: number }).v;

  const tasksPaid = (db.prepare(
    "SELECT COUNT(*) AS v FROM transactions WHERE to_agent=? AND status='completed'"
  ).get(agentId) as { v: number }).v;

  return {
    agentId,
    totalEarned: earned,
    totalSpent: spent,
    totalEscrow: escrow,
    netBalance: earned - spent,
    tasksPaid,
  };
}


export function parsePriceToSol(price: string | undefined): number | null {
  if (!price) return null;
  const parsed = parsePaymentAmount(price);
  if (!parsed) return null;
  // Return amount regardless of currency — used to detect "is this paid?"
  return parsed.amount > 0 ? parsed.amount : null;
}
