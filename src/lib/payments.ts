import { randomUUID } from "crypto";
import { getDb } from "./db";
import { parsePaymentAmount, verifyIncomingPayment, isValidSolanaAddress } from "./solana";
import { queueWebhookEvent } from "./webhooks";
import { checkBudget } from "./budgets";
import { getAgentById } from "./agents";
import { logger } from "./logger";
import { syncToTurso } from "./db-turso";

export type PaymentStatus = "escrow" | "completed" | "refunded";

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
}): Promise<Payment> {
  const db = getDb();

  const base = parsePaymentAmount(opts.priceString ?? `${opts.amountSol} SOL`);
  if (!base) throw new Error("Payment amount must be a positive SOL or USDC amount");

  // Fast pre-check for replay and budget before hitting the Solana RPC
  const existingFast = db
    .prepare("SELECT 1 FROM transactions WHERE incoming_signature = ?")
    .get(opts.paymentSignature);
  if (existingFast) throw new Error("Payment signature already used");

  // Verify on-chain — async network call, must happen outside the SQLite transaction
  const payerWallet = resolvePayerWallet(opts.fromAgent);
  if (!payerWallet) {
    throw new Error("Payment payer must be a wallet address or an agent with a walletAddress");
  }

  const verified = await verifyIncomingPayment(opts.paymentSignature, base, payerWallet);
  if (!verified) throw new Error(
    `Payment not verified on-chain. Expected ${base.amount.toFixed(base.currency === "USDC" ? 2 : 4)} ${base.currency} signed by ${payerWallet}`
  );

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

  void syncToTurso();
  return payment;
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
  const row = getDb()
    .prepare("SELECT * FROM transactions WHERE task_id = ?")
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
