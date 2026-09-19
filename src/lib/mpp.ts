// MPP (Machine Payment Protocol) — pre-paid ETH channels for batch agent calls.
//
// The balance is an exact wei count held as text and worked on as a BigInt. It does not live in a
// number, and the arithmetic does not happen inside SQL: wei overflows a double at about 0.009 ETH
// and a 64-bit column at about 9, and a balance that silently truncates is one somebody can spend
// twice.
//
// Flow:
//   1. Client sends ETH on-chain to the payment receiver wallet (same as x402)
//   2. Client POSTs the tx signature to open a channel — verified on-chain before credit
//   3. Server issues a channelKey (returned once, plaintext — store it securely)
//   4. Client authenticates via Authorization: Bearer <channelKey>
//   5. Each agent call debits the channel balance atomically (no on-chain tx per call)
//   6. Client can top up by making another on-chain ETH deposit
//   7. Client closes the channel when done

import { randomUUID, createHash } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { parsePaymentAmount, parseAmount, verifyIncomingPayment, weiToEth, formatEth } from "./money";

interface ChannelRow {
  channel_id: string;
  owner_address: string;
  key_hash: string;
  balance_eth: number;
  balance_wei: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MppChannel {
  channelId: string;
  ownerAddress: string;
  balanceEth: number;
  status: "open" | "closing" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface DebitResult {
  success: boolean;
  error?: string;
  remainingBalance?: number;
}

export interface MppAmount {
  amountEth: number;
  wei: bigint;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A channel's stored balance, as the exact BigInt it is. */
function balanceWei(row: { balance_wei: string | number | null }): bigint {
  try {
    return BigInt(row.balance_wei ?? 0);
  } catch {
    return 0n;
  }
}

export function parseMppAmount(amount: unknown): MppAmount | null {
  const parsed = parseAmount(amount);
  return parsed ? { amountEth: parsed.amount, wei: parsed.wei } : null;
}

export function parseMppPrice(price: string): MppAmount | null {
  const parsed = parsePaymentAmount(price);
  return parsed ? { amountEth: weiToEth(parsed.wei), wei: parsed.wei } : null;
}

function rowToChannel(row: ChannelRow): MppChannel {
  return {
    channelId: row.channel_id,
    ownerAddress: row.owner_address,
    balanceEth: weiToEth(balanceWei(row)),
    status: row.status as MppChannel["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Deposit verification ───────────────────────────────────────────────────────

// Verifies an on-chain payment and guards against cross-system replay attacks.
// Throws for config errors (a missing treasury address etc.) so callers can return 503.
// Returns { verified: false } only for genuine payment failures.
export async function verifyMppDeposit(
  signature: string,
  amount: MppAmount,
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
      { amount: amount.amountEth, currency: "ETH", wei: amount.wei },
      expectedSigner
    );
    return ok
      ? { verified: true }
      : {
          verified: false,
          error: `On-chain transfer not found. Expected ${formatEth(amount.wei)} to the payment receiver wallet.`,
        };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Verification failed";
    // Config errors must propagate so callers can return 503 instead of 402
    if (/is not set|API_KEY|PRIVATE_KEY|RPC_URL/i.test(msg)) throw err;
    return { verified: false, error: msg };
  }
}

// Atomically records a verified deposit and credits the channel balance.
// The UNIQUE constraint on mpp_deposits.signature is the final replay lock —
// if two requests race past the async on-chain check, only one INSERT wins.
export function recordDeposit(
  channelId: string,
  amount: MppAmount,
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
      INSERT INTO mpp_deposits (deposit_id, channel_id, amount_eth, amount_wei, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), channelId, amount.amountEth, amount.wei.toString(), signature, now);

    // Read, add, write back. SQL cannot add text wei, and this sits inside the same serialized
    // transaction as the replay check, so no other writer can interleave.
    const current = balanceWei(
      db.prepare("SELECT balance_wei FROM mpp_channels WHERE channel_id = ?").get(channelId) as { balance_wei: string },
    );
    const next = current + amount.wei;
    db.prepare(
      `UPDATE mpp_channels SET balance_wei = ?, balance_eth = ?, updated_at = ? WHERE channel_id = ?`
    ).run(next.toString(), weiToEth(next), now, channelId);
  })();
  void syncToTurso();
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
    INSERT INTO mpp_channels (channel_id, owner_address, key_hash, balance_eth, balance_wei, status, created_at, updated_at)
    VALUES (?, ?, ?, 0, '0', 'open', ?, ?)
  `).run(channelId, ownerAddress, hashKey(channelKey), now, now);

  const row = db
    .prepare("SELECT * FROM mpp_channels WHERE channel_id = ?")
    .get(channelId) as ChannelRow;
  void syncToTurso();
  return { channel: rowToChannel(row), channelKey };
}

export function deleteChannel(channelId: string): void {
  getDb().prepare("DELETE FROM mpp_channels WHERE channel_id = ?").run(channelId);
  void syncToTurso();
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
  amount: MppAmount,
  taskId?: string
): DebitResult {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.transaction((): DebitResult => {
    const row = db
      .prepare("SELECT * FROM mpp_channels WHERE channel_id = ? AND status = 'open'")
      .get(channelId) as ChannelRow | undefined;

    if (!row) return { success: false, error: "Channel not found or closed" };
    const available = balanceWei(row);
    // Exact: a channel may never be debited past what it holds, not even by a rounding error.
    if (available < amount.wei) {
      return {
        success: false,
        error: `Insufficient balance: ${formatEth(available)} available, need ${formatEth(amount.wei)}`,
      };
    }

    const remaining = available - amount.wei;
    db.prepare(
      `UPDATE mpp_channels SET balance_wei = ?, balance_eth = ?, updated_at = ? WHERE channel_id = ?`
    ).run(remaining.toString(), weiToEth(remaining), now, channelId);

    db.prepare(`
      INSERT INTO mpp_debits (debit_id, channel_id, agent_id, amount_eth, amount_wei, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), channelId, agentId, amount.amountEth, amount.wei.toString(), taskId ?? null, now);

    db.prepare(`
      INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, settled_at)
      VALUES (?, ?, ?, ?, ?, 'completed', NULL, 0, 'ETH', ?, ?)
    `).run(randomUUID(), taskId ?? null, row.owner_address, agentId, amount.amountEth, now, now);

    return { success: true, remainingBalance: weiToEth(remaining) };
  })();
  void syncToTurso();
  return result;
}

export function refundDebitForTask(taskId: string): DebitResult {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.transaction((): DebitResult => {
    const debit = db
      .prepare("SELECT debit_id, channel_id, amount_wei FROM mpp_debits WHERE task_id = ?")
      .get(taskId) as { debit_id: string; channel_id: string; amount_wei: string } | undefined;

    if (!debit) return { success: true };

    // If the channel is no longer open, it already settled its full balance
    // on-chain at close. A late refund (e.g. a completed task later requeued/
    // failed) must be a complete no-op: crediting would recreate phantom funds,
    // and marking the transaction refunded would be false. Leave it untouched.
    const channel = db
      .prepare("SELECT status FROM mpp_channels WHERE channel_id = ?")
      .get(debit.channel_id) as { status: string } | undefined;
    if (!channel || channel.status !== "open") {
      return { success: true };
    }

    const current = balanceWei(
      db.prepare("SELECT balance_wei FROM mpp_channels WHERE channel_id = ?").get(debit.channel_id) as { balance_wei: string },
    );
    const restored = current + BigInt(debit.amount_wei || 0);
    db.prepare(
      `UPDATE mpp_channels SET balance_wei = ?, balance_eth = ?, updated_at = ? WHERE channel_id = ?`
    ).run(restored.toString(), weiToEth(restored), now, debit.channel_id);
    db.prepare("DELETE FROM mpp_debits WHERE debit_id = ?").run(debit.debit_id);
    db.prepare("UPDATE transactions SET status='refunded', settled_at=? WHERE task_id=? AND currency='ETH' AND status='completed'")
      .run(now, taskId);

    return { success: true, remainingBalance: weiToEth(restored) };
  })();
  void syncToTurso();
  return result;
}

export function claimChannelClose(channelId: string): MppChannel | null {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.transaction((): MppChannel | null => {
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
  void syncToTurso();
  return result;
}

export function finalizeChannelClose(channelId: string, zeroBalance: boolean): MppChannel | null {
  const db = getDb();
  const now = new Date().toISOString();
  const changes = db
    .prepare(
      `UPDATE mpp_channels
       SET status = 'closed',
           balance_wei = CASE WHEN ? THEN '0' ELSE balance_wei END,
           balance_eth = CASE WHEN ? THEN 0 ELSE balance_eth END,
           updated_at = ?
       WHERE channel_id = ? AND status = 'closing'`
    )
    .run(zeroBalance ? 1 : 0, zeroBalance ? 1 : 0, now, channelId).changes;
  const result = changes > 0 ? getChannelById(channelId) : null;
  void syncToTurso();
  return result;
}
