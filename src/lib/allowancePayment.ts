// Paying for a hire out of an on-chain allowance, and keeping the chain in step with the ledger.
//
// Two halves.
//
// payFromAllowance, at hire time: check the owner's rules against the chain, reserve the price on
// chain, verify the reservation, and write the same escrow row any other payment writes, funded
// from 'allowance' and proven by the reserve transaction. From there the task is simply paid: every
// path that completes, fails, splits or penalises a task already knows what to do with an escrow row.
//
// reconcileAllowances, in the background: the ledger decides what happened to a task, and this makes
// the chain agree. A completed or split payment settles its reservation to the receiver; a refunded
// one, or a reservation whose task never got written, releases back to the owner. Settlement happens
// in twelve different places in the codebase, and none of them had to change: they move the ledger,
// and this follows the ledger. It is idempotent, so a crash between the chain and the database
// resolves itself on the next pass.

import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { parsePaymentAmount, weiToEth, formatEth } from "./money";
import { checkBudget } from "./budgets";
import { getQuote, isExpired, createQuote, axonPaymentsEnabled } from "./axonQuote";
import { getAgentById } from "./agents";
import { axonPaymentRefusal, createAxonPayment } from "./axonPayment";
import { isTransientRpcError } from "./evm";
import { keyLimitError } from "./allowanceKeys";
import { logger } from "./logger";
import {
  allowancesEnabled,
  agentKey,
  taskKey,
  NATIVE_TOKEN,
  OPERATOR_KEY_ENV,
  RESERVATION_TIMEOUT_SECONDS,
} from "./allowancePolicy";
import {
  readAccount,
  isAgentAllowed,
  reservationsPausedOnChain,
  reserveOnChain,
  reservationState,
  settleManyOnChain,
  releaseManyOnChain,
  contractRefusal,
} from "./allowanceChain";

/** A refusal the caller should show as-is. `status` is the HTTP status it maps to. */
export class AllowancePaymentError extends Error {
  constructor(message: string, readonly status: 402 | 503 = 402) {
    super(message);
    this.name = "AllowancePaymentError";
  }
}

export interface AllowanceHire {
  taskId: string;
  fromAgent: string;
  toAgent: string;
  /** The wallet whose allowance pays. The route passes the authenticated caller's wallet, never input. */
  owner: string;
  /** The agent's listed price, e.g. "0.0005 ETH". Used for ETH hires. */
  priceString: string;
  /** Pay in $AXON at this quote instead of ETH. */
  quoteId?: string;
  /** The allowance key paying, when it is one. Its own limits are checked before anything is reserved. */
  apiKeyId?: string;
}

export interface AllowancePaid {
  txId: string;
  reserveTx: string;
  token: string;
  amountUnits: bigint;
}

const unitsLabel = (units: bigint, token: string): string =>
  token === NATIVE_TOKEN ? formatEth(units) : `${weiToEth(units)} $AXON`;

/**
 * Everything the contract would check, asked of the chain first, so a hire that would be refused
 * says why in words and never spends gas on a reservation that reverts.
 */
async function preflight(owner: string, token: string, agent: Hex, amount: bigint): Promise<void> {
  if (await reservationsPausedOnChain()) {
    throw new AllowancePaymentError("Allowance payments are paused right now", 503);
  }
  const a = await readAccount(owner, token);
  const label = (u: bigint) => unitsLabel(u, token);
  if (a.maxPerTask === 0n) throw new AllowancePaymentError("This wallet has no allowance set up for this token");
  if (a.paused) throw new AllowancePaymentError("Your allowance is paused");
  if (BigInt(Math.floor(Date.now() / 1000)) >= a.expiresAt) throw new AllowancePaymentError("Your allowance has expired");
  if (amount > a.maxPerTask) {
    throw new AllowancePaymentError(`This hire costs ${label(amount)}, over your per-task limit of ${label(a.maxPerTask)}`);
  }
  if (a.spentToday + amount > a.maxPerDay) {
    throw new AllowancePaymentError(
      `This hire costs ${label(amount)} and ${label(a.maxPerDay - a.spentToday)} of today's limit is left`,
    );
  }
  if (a.restrict && !(await isAgentAllowed(owner, token, agent))) {
    throw new AllowancePaymentError("This agent is not on your allowance's allowed list");
  }
  if (a.available < amount) {
    throw new AllowancePaymentError(`Your allowance has ${label(a.available)} available, this hire needs ${label(amount)}`);
  }
}

/** Pay for a task from the owner's allowance. Throws AllowancePaymentError with a showable reason. */
export async function payFromAllowance(h: AllowanceHire): Promise<AllowancePaid> {
  if (!allowancesEnabled()) throw new AllowancePaymentError("Allowance payments are not available", 503);
  if (!process.env[OPERATOR_KEY_ENV]?.trim()) throw new AllowancePaymentError("Allowance payments are not available", 503);

  // What is being paid, in what, and what it is worth in ETH (the unit a key's limits are set in).
  let token: string;
  let amount: bigint;
  let ethWei: bigint;
  if (h.quoteId) {
    const quote = getQuote(h.quoteId);
    const axon = process.env.AXON_SETTLEMENT_TOKEN_ADDRESS?.trim();
    if (!quote || !axon) throw new AllowancePaymentError("Unknown quote");
    if (quote.consumedAt) throw new AllowancePaymentError("That quote has already been paid");
    if (isExpired(quote)) throw new AllowancePaymentError("That quote has expired, ask for a new one");
    const refusal = axonPaymentRefusal({ taskId: h.taskId, fromAgent: h.fromAgent, toAgent: h.toAgent });
    if (refusal) throw new AllowancePaymentError(`This hire cannot be paid in $AXON (${refusal})`);
    token = axon.toLowerCase();
    amount = quote.axonUnits;
    ethWei = quote.ethWei;
  } else {
    const base = parsePaymentAmount(h.priceString);
    if (!base) throw new AllowancePaymentError("This agent has no ETH price to pay");
    try {
      checkBudget(h.fromAgent, h.toAgent, base.wei);
    } catch (err) {
      throw new AllowancePaymentError(err instanceof Error ? err.message : "Budget exceeded");
    }
    token = NATIVE_TOKEN;
    amount = base.wei;
    ethWei = base.wei;
  }

  if (h.apiKeyId) {
    const keyError = keyLimitError(h.apiKeyId, h.toAgent, ethWei);
    if (keyError) throw new AllowancePaymentError(keyError);
  }

  const tKey = taskKey(h.taskId);
  const aKey = agentKey(h.toAgent);

  let reserveTx: Hex;
  try {
    await preflight(h.owner, token, aKey, amount);
    ({ txHash: reserveTx } = await reserveOnChain({ owner: h.owner, token, taskKey: tKey, agentKey: aKey, amount }));
  } catch (err) {
    if (err instanceof AllowancePaymentError) throw err;
    const refusal = contractRefusal(err);
    if (refusal) throw new AllowancePaymentError(refusal, refusal.includes("paused right now") ? 503 : 402);
    logger.warn("allowance.reserve_failed", "Could not reserve from an allowance", {
      taskId: h.taskId, owner: h.owner, err: err instanceof Error ? err.message : String(err),
    });
    throw new AllowancePaymentError(
      isTransientRpcError(err) ? "The chain is not answering, try again shortly" : "The allowance refused this payment",
      isTransientRpcError(err) ? 503 : 402,
    );
  }

  // The money is locked on chain from here. If the ledger cannot record it, give it straight back
  // rather than leave it reserved against a task that does not exist.
  try {
    const txId = h.quoteId
      ? await recordAxon(h, reserveTx)
      : recordEth(h, reserveTx, amount);
    getDb().prepare(`
      INSERT INTO allowance_reservations
        (task_id, tx_id, owner, token, task_key, agent_key, amount_units, reserve_tx, state, created_at, api_key_id, eth_wei)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
    `).run(
      h.taskId, txId, h.owner.toLowerCase(), token, tKey, aKey, amount.toString(), reserveTx,
      new Date().toISOString(), h.apiKeyId ?? null, ethWei.toString(),
    );
    void syncToTurso();
    logger.info("allowance.reserved", "Hire paid from an allowance", {
      taskId: h.taskId, txId, owner: h.owner, token, amount: amount.toString(), reserveTx,
    });
    return { txId, reserveTx, token, amountUnits: amount };
  } catch (err) {
    logger.error("allowance.record_failed", "Reserved on chain but could not record; releasing", {
      taskId: h.taskId, reserveTx, err: err instanceof Error ? err.message : String(err),
    });
    await releaseManyOnChain([tKey]).catch((releaseErr) => {
      // The reconciler cannot see a reservation that was never written, but the owner can still
      // reclaim it themselves after the timeout. Loud, because that is a real person's money.
      logger.error("allowance.release_after_record_failure_failed", "Could not release a stranded reservation", {
        taskId: h.taskId, reserveTx, err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    });
    throw new AllowancePaymentError("Payment could not be recorded and was returned to your allowance", 503);
  }
}

function recordEth(h: AllowanceHire, reserveTx: string, wei: bigint): string {
  const db = getDb();
  const txId = randomUUID();
  db.transaction(() => {
    // Checked again inside the write, like every other payment, so two hires racing each other
    // cannot both pass a budget that has room for only one.
    checkBudget(h.fromAgent, h.toAgent, wei);
    db.prepare(`
      INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, funding_source)
      VALUES (?, ?, ?, ?, ?, 'escrow', ?, 0, 'ETH', ?, 'allowance')
    `).run(txId, h.taskId, h.fromAgent, h.toAgent, weiToEth(wei), reserveTx, new Date().toISOString());
  })();
  return txId;
}

async function recordAxon(h: AllowanceHire, reserveTx: string): Promise<string> {
  const result = await createAxonPayment({
    taskId: h.taskId,
    fromAgent: h.fromAgent,
    toAgent: h.toAgent,
    quoteId: h.quoteId!,
    txHash: reserveTx,
    proof: "allowance",
  });
  if (!result.ok) throw new Error(`$AXON payment not recorded: ${result.reason}`);
  getDb().prepare("UPDATE transactions SET funding_source = 'allowance' WHERE tx_id = ?").run(result.payment.txId);
  return result.payment.txId;
}

/**
 * A quote of its own for one allowance hire in $AXON.
 *
 * Never the x402 quote: that one is shared by everybody asking in the same window, and an allowance
 * reservation consumes the quote it pays, so a shared quote would refuse the next person hiring the
 * same agent. Throws AllowancePaymentError with a reason a caller can show.
 */
export async function freshAxonQuoteFor(agentId: string): Promise<string> {
  const agent = getAgentById(agentId);
  if (!agent) throw new AllowancePaymentError("Unknown agent");
  if (!axonPaymentsEnabled()) throw new AllowancePaymentError("$AXON payments are not available", 503);
  if (!agent.acceptsAxon) throw new AllowancePaymentError(`${agentId} does not accept $AXON; pay in ETH instead`);
  const parsed = agent.price ? parsePaymentAmount(agent.price) : null;
  if (!parsed) throw new AllowancePaymentError("This agent has no ETH price to quote in $AXON");
  const quoted = await createQuote({ ethWei: parsed.wei, reference: `allowance:${agentId}`, discountBps: agent.axonDiscountBps ?? 0 });
  if (!quoted.ok) throw new AllowancePaymentError(`Could not quote this hire in $AXON (${quoted.reason})`, 503);
  return quoted.quote.quoteId;
}

// ── Reconciler ───────────────────────────────────────────────────────────────

/** The contract takes at most this many keys per batch here, to keep each transaction's gas bounded. */
const BATCH = 50;
/** Warn well before an owner could reclaim, so an unsettled completed task is fixed while it still can be. */
const WARN_BEFORE_TIMEOUT_SECONDS = 4 * 60 * 60;

interface OpenRow {
  task_id: string;
  task_key: Hex;
  created_at: string;
  ledger: string | null;
}

export interface ReconcileResult {
  settled: number;
  released: number;
  /** Reservations the chain had already closed, brought back in line in the database. */
  synced: number;
}

function close(taskKeys: Hex[], state: "settled" | "released" | "reclaimed", closeTx: string | null): void {
  const stmt = getDb().prepare(
    "UPDATE allowance_reservations SET state = ?, close_tx = ?, closed_at = ? WHERE task_key = ? AND state = 'reserved'",
  );
  const now = new Date().toISOString();
  getDb().transaction(() => {
    for (const k of taskKeys) stmt.run(state, closeTx, now, k);
  })();
}

export async function reconcileAllowances(): Promise<ReconcileResult> {
  const result: ReconcileResult = { settled: 0, released: 0, synced: 0 };
  if (!allowancesEnabled() || !process.env[OPERATOR_KEY_ENV]?.trim()) return result;

  const open = getDb().prepare(`
    SELECT r.task_id, r.task_key, r.created_at, t.status AS ledger
    FROM allowance_reservations r
    LEFT JOIN transactions t ON t.tx_id = r.tx_id
    WHERE r.state = 'reserved'
  `).all() as OpenRow[];
  if (open.length === 0) return result;

  const toSettle: Hex[] = [];
  const toRelease: Hex[] = [];
  const nowSeconds = Date.now() / 1000;

  for (const row of open) {
    const decided =
      row.ledger === "completed" || row.ledger === "split" ? "settle"
      : row.ledger === "refunded" || row.ledger === null ? "release"
      : null;
    if (!decided) {
      const age = nowSeconds - Date.parse(row.created_at) / 1000;
      if (age > RESERVATION_TIMEOUT_SECONDS - WARN_BEFORE_TIMEOUT_SECONDS) {
        logger.warn("allowance.reservation_aging", "A reservation is close to its reclaim window and its task is still open", {
          taskId: row.task_id, ageHours: Math.round(age / 3600),
        });
      }
      continue;
    }

    // Ask the chain before acting on it: the owner may have reclaimed, or a previous pass may have
    // landed on chain and crashed before writing it down.
    const onChain = await reservationState(row.task_key);
    if (onChain !== "reserved") {
      if (onChain === "settled" || onChain === "released" || onChain === "reclaimed") {
        close([row.task_key], onChain, null);
        result.synced++;
        if (onChain === "reclaimed" && decided === "settle") {
          // The agent was paid in the ledger for work whose money the owner took back. Only possible
          // if settlement stalled for a whole day.
          logger.error("allowance.reclaimed_before_settle", "An owner reclaimed a reservation for completed work", {
            taskId: row.task_id,
          });
        }
      }
      continue;
    }
    (decided === "settle" ? toSettle : toRelease).push(row.task_key);
  }

  // The contract skips a key that stopped being reserved between the read above and the batch landing
  // (an owner reclaiming at that moment), so what each key became is read back rather than assumed.
  const record = async (chunk: Hex[], tx: string) => {
    for (const k of chunk) {
      const state = await reservationState(k);
      if (state === "settled" || state === "released" || state === "reclaimed") {
        close([k], state, state === "reclaimed" ? null : tx);
        if (state === "settled") result.settled++;
        else if (state === "released") result.released++;
        else result.synced++;
      }
    }
  };
  for (let i = 0; i < toSettle.length; i += BATCH) {
    const chunk = toSettle.slice(i, i + BATCH);
    await record(chunk, await settleManyOnChain(chunk));
  }
  for (let i = 0; i < toRelease.length; i += BATCH) {
    const chunk = toRelease.slice(i, i + BATCH);
    await record(chunk, await releaseManyOnChain(chunk));
  }

  if (result.settled || result.released || result.synced) {
    logger.info("allowance.reconciled", "Allowance reservations brought in line with the ledger", { ...result });
    void syncToTurso();
  }
  return result;
}
