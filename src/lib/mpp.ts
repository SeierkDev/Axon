// MPP (Machine Payment Protocol) — pre-paid USDC channels for batch agent calls.
//
// Flow:
//   1. Client sends USDC on-chain to the payment receiver wallet (same as x402)
//   2. Client POSTs the tx signature to open a channel — verified on-chain before credit
//   3. Server issues a channelKey (returned once, plaintext — store it securely)
//   4. Client authenticates via Authorization: Bearer <channelKey>
//   5. Each agent call debits the channel balance atomically (no on-chain tx per call)
//   6. Client can top up by making another on-chain USDC deposit
//   7. Client closes the channel when done

import { randomUUID, createHash } from "crypto";
import { getDb } from "./db";
import { parsePaymentAmount, parseUsdcAmount, verifyIncomingPayment } from "./solana";

const MICRO_USDC = 1_000_000;
const MAX_SAFE_MICRO_USDC = BigInt(Number.MAX_SAFE_INTEGER);

interface ChannelRow {
  channel_id: string;
  owner_address: string;
  key_hash: string;
  balance_usdc: number;
  balance_micro_usdc: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MppChannel {
  channelId: string;
  ownerAddress: string;
  balanceUsdc: number;
  status: "open" | "closing" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface DebitResult {
  success: boolean;
  error?: string;
  remainingBalance?: number;
}

export interface MppUsdcAmount {
  amountUsdc: number;
  microUsdc: number;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function microToUsdc(microUsdc: number): number {
  return microUsdc / MICRO_USDC;
}

function parsedUnitsToMicro(units: bigint): number | null {
  return units > MAX_SAFE_MICRO_USDC ? null : Number(units);
}

export function parseMppUsdcAmount(amount: unknown): MppUsdcAmount | null {
  const parsed = parseUsdcAmount(amount);
  if (!parsed) return null;
  const microUsdc = parsedUnitsToMicro(parsed.units);
  if (microUsdc === null) return null;
  return { amountUsdc: microToUsdc(microUsdc), microUsdc };
}

export function parseMppUsdcPrice(price: string): MppUsdcAmount | null {
  const parsed = parsePaymentAmount(price);
  if (!parsed || parsed.currency !== "USDC") return null;
  const microUsdc = parsedUnitsToMicro(parsed.units);
  if (microUsdc === null) return null;
  return { amountUsdc: microToUsdc(microUsdc), microUsdc };
}

function rowToChannel(row: ChannelRow): MppChannel {
  return {
    channelId: row.channel_id,
    ownerAddress: row.owner_address,
    balanceUsdc: microToUsdc(row.balance_micro_usdc),
    status: row.status as MppChannel["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Deposit verification ───────────────────────────────────────────────────────

// Verifies a USDC on-chain payment and guards against cross-system replay attacks.
// Throws for config errors (missing HELIUS_API_KEY etc.) so callers can return 503.
// Returns { verified: false } only for genuine payment failures.
export async function verifyMppDeposit(
  signature: string,
  amount: MppUsdcAmount,
  expectedSigner?: string
): Promise<{ verified: boolean; error?: string }> {
  const db = getDb();

  // Replay check — signature must not exist in either payment system
  const usedInTx = db
    .prepare("SELECT 1 FROM transactions WHERE incoming_signature = ?")
    .get(signature);
  if (usedInTx) return { verified: false, error: "Deposit signature already used in another payment" };

  const usedInMpp = db
    .prepare("SELECT 1 FROM mpp_deposits WHERE signature = ?")
    .get(signature);
  if (usedInMpp) return { verified: false, error: "Deposit signature already used for an MPP channel" };

  try {
    const ok = await verifyIncomingPayment(
      signature,
      { amount: amount.amountUsdc, currency: "USDC", units: BigInt(amount.microUsdc) },
      expectedSigner
    );
    return ok
      ? { verified: true }
      : {
          verified: false,
          error: `On-chain USDC transfer not found. Expected ${amount.amountUsdc.toFixed(2)} USDC to the payment receiver wallet.`,
        };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Verification failed";
    // Config errors must propagate so callers can return 503 instead of 402
    if (/is not set|API_KEY|HELIUS/i.test(msg)) throw err;
    return { verified: false, error: msg };
  }
}

// Atomically records a verified deposit and credits the channel balance.
// The UNIQUE constraint on mpp_deposits.signature is the final replay lock —
// if two requests race past the async on-chain check, only one INSERT wins.
export function recordDeposit(
  channelId: string,
  amount: MppUsdcAmount,
  signature: string
): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.transaction(() => {
    // Double-check replay inside the serialized write transaction
    const used = db
      .prepare("SELECT 1 FROM mpp_deposits WHERE signature = ?")
      .get(signature);
    if (used) throw new Error("Deposit signature already used");

    const channel = db
      .prepare("SELECT 1 FROM mpp_channels WHERE channel_id = ? AND status = 'open'")
      .get(channelId);
    if (!channel) throw new Error("Channel not found or not open");

    db.prepare(`
      INSERT INTO mpp_deposits (deposit_id, channel_id, amount_usdc, amount_micro_usdc, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), channelId, amount.amountUsdc, amount.microUsdc, signature, now);

    db.prepare(
      `UPDATE mpp_channels
       SET balance_micro_usdc = balance_micro_usdc + ?,
           balance_usdc = (balance_micro_usdc + ?) / 1000000.0,
           updated_at = ?
       WHERE channel_id = ?`
    ).run(amount.microUsdc, amount.microUsdc, now, channelId);
  })();
}

// ── Channel lifecycle ──────────────────────────────────────────────────────────

// Creates a channel with 0 balance. Caller must follow with recordDeposit()
// after verifying the on-chain deposit.
export function createChannel(
  ownerAddress: string
): { channel: MppChannel; channelKey: string } {
  const db = getDb();
  const channelId = randomUUID();
  // Two UUIDs concatenated — 71 chars of entropy; returned once, then only the hash is kept
  const channelKey = `${randomUUID()}-${randomUUID()}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO mpp_channels (channel_id, owner_address, key_hash, balance_usdc, balance_micro_usdc, status, created_at, updated_at)
    VALUES (?, ?, ?, 0, 0, 'open', ?, ?)
  `).run(channelId, ownerAddress, hashKey(channelKey), now, now);

  const row = db
    .prepare("SELECT * FROM mpp_channels WHERE channel_id = ?")
    .get(channelId) as ChannelRow;
  return { channel: rowToChannel(row), channelKey };
}

export function deleteChannel(channelId: string): void {
  getDb().prepare("DELETE FROM mpp_channels WHERE channel_id = ?").run(channelId);
}

export function getChannelById(channelId: string): MppChannel | null {
  const row = getDb()
    .prepare("SELECT * FROM mpp_channels WHERE channel_id = ?")
    .get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : null;
}

export function getChannelsByOwner(ownerAddress: string): MppChannel[] {
  const rows = getDb()
    .prepare("SELECT * FROM mpp_channels WHERE owner_address = ? ORDER BY created_at DESC")
    .all(ownerAddress) as ChannelRow[];
  return rows.map(rowToChannel);
}

export function verifyChannelKey(channelId: string, key: string): boolean {
  const row = getDb()
    .prepare("SELECT key_hash FROM mpp_channels WHERE channel_id = ?")
    .get(channelId) as { key_hash: string } | undefined;
  if (!row) return false;
  return row.key_hash === hashKey(key);
}

// ── Per-call debit ─────────────────────────────────────────────────────────────

export function debitChannel(
  channelId: string,
  agentId: string,
  amount: MppUsdcAmount,
  taskId?: string
): DebitResult {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction((): DebitResult => {
    const row = db
      .prepare("SELECT * FROM mpp_channels WHERE channel_id = ? AND status = 'open'")
      .get(channelId) as ChannelRow | undefined;

    if (!row) return { success: false, error: "Channel not found or closed" };
    if (row.balance_micro_usdc < amount.microUsdc) {
      return {
        success: false,
        error: `Insufficient balance: ${microToUsdc(row.balance_micro_usdc).toFixed(4)} USDC available, need ${amount.amountUsdc.toFixed(4)}`,
      };
    }

    db.prepare(
      `UPDATE mpp_channels
       SET balance_micro_usdc = balance_micro_usdc - ?,
           balance_usdc = (balance_micro_usdc - ?) / 1000000.0,
           updated_at = ?
       WHERE channel_id = ?`
    ).run(amount.microUsdc, amount.microUsdc, now, channelId);

    db.prepare(`
      INSERT INTO mpp_debits (debit_id, channel_id, agent_id, amount_usdc, amount_micro_usdc, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), channelId, agentId, amount.amountUsdc, amount.microUsdc, taskId ?? null, now);

    db.prepare(`
      INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at)
      VALUES (?, ?, ?, ?, ?, 'completed', NULL, 0, 'USDC', ?, ?)
    `).run(randomUUID(), taskId ?? null, row.owner_address, agentId, amount.amountUsdc, now, now);

    const updated = db
      .prepare("SELECT balance_micro_usdc FROM mpp_channels WHERE channel_id = ?")
      .get(channelId) as { balance_micro_usdc: number };

    return { success: true, remainingBalance: microToUsdc(updated.balance_micro_usdc) };
  })();
}

export function refundDebitForTask(taskId: string): DebitResult {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction((): DebitResult => {
    const debit = db
      .prepare("SELECT debit_id, channel_id, amount_micro_usdc FROM mpp_debits WHERE task_id = ?")
      .get(taskId) as { debit_id: string; channel_id: string; amount_micro_usdc: number } | undefined;

    if (!debit) return { success: true };

    db.prepare(
      `UPDATE mpp_channels
       SET balance_micro_usdc = balance_micro_usdc + ?,
           balance_usdc = (balance_micro_usdc + ?) / 1000000.0,
           updated_at = ?
       WHERE channel_id = ?`
    ).run(debit.amount_micro_usdc, debit.amount_micro_usdc, now, debit.channel_id);
    db.prepare("DELETE FROM mpp_debits WHERE debit_id = ?").run(debit.debit_id);
    db.prepare("UPDATE transactions SET status='refunded', settled_at=? WHERE task_id=? AND currency='USDC' AND status='completed'")
      .run(now, taskId);

    const updated = db
      .prepare("SELECT balance_micro_usdc FROM mpp_channels WHERE channel_id = ?")
      .get(debit.channel_id) as { balance_micro_usdc: number } | undefined;

    return { success: true, remainingBalance: updated ? microToUsdc(updated.balance_micro_usdc) : undefined };
  })();
}

export function claimChannelClose(channelId: string): MppChannel | null {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction((): MppChannel | null => {
    const changes = db.prepare(`
      UPDATE mpp_channels
      SET status = 'closing', updated_at = ?
      WHERE channel_id = ?
        AND status = 'open'
        AND NOT EXISTS (
          SELECT 1
          FROM mpp_debits d
          LEFT JOIN tasks t ON t.task_id = d.task_id
          WHERE d.channel_id = mpp_channels.channel_id
            AND (d.task_id IS NULL OR t.status IN ('queued', 'running'))
        )
    `).run(now, channelId).changes;

    if (changes === 0) return null;

    const row = db
      .prepare("SELECT * FROM mpp_channels WHERE channel_id = ?")
      .get(channelId) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  })();
}

export function finalizeChannelClose(channelId: string, zeroBalance: boolean): MppChannel | null {
  const db = getDb();
  const now = new Date().toISOString();
  const changes = db
    .prepare(
      `UPDATE mpp_channels
       SET status = 'closed',
           balance_micro_usdc = CASE WHEN ? THEN 0 ELSE balance_micro_usdc END,
           balance_usdc = CASE WHEN ? THEN 0 ELSE balance_usdc END,
           updated_at = ?
       WHERE channel_id = ? AND status = 'closing'`
    )
    .run(zeroBalance ? 1 : 0, zeroBalance ? 1 : 0, now, channelId).changes;
  return changes > 0 ? getChannelById(channelId) : null;
}
