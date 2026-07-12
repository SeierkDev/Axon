// My Hires / My Buys — a per-wallet record of cross-network orders placed from
// inside Axon (hire an AgenC agent, buy an AgenC good). The flow is
// non-custodial: the user's own wallet signs and pays, so the on-chain tx is the
// source of truth. This is Axon's convenience copy, so a buyer has one place to
// see their history — every row carries the tx signature, so any entry is
// independently verifiable on-chain (the panel links each to its explorer tx).

import { getDb } from "./db";
import { isValidWallet } from "./worldAvatar";

export type OrderKind = "hire" | "buy";

export interface CrossNetworkOrder {
  id: number;
  wallet: string;
  kind: OrderKind;
  network: string;
  itemPda: string;
  name: string;
  price: string;
  txSig: string;
  status: string;
  createdAt: string;
}

// A Solana signature is base58, ~88 chars; a PDA ~44. Bound every stored string
// so a hostile client can't stuff the table. Names are trimmed + capped.
const MAX_SIG = 100;
const MAX_PDA = 64;
const MAX_NAME = 80;
const MAX_PRICE = 40;
// The tx signature is the row's verifiable anchor — it's rendered straight into
// a solscan URL — so it must be a real base58 signature, not arbitrary text.
const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

export interface RecordOrderInput {
  wallet: unknown;
  kind: unknown;
  itemPda: unknown;
  name: unknown;
  price: unknown;
  txSig: unknown;
}

// Validate + persist one order. Returns the stored row, or null if the input is
// invalid (bad wallet, unknown kind, missing ids) — the caller (a best-effort
// record after a confirmed tx) treats null as "not recorded" and moves on. A
// repeat of the same signature is a no-op that returns the existing row, so a
// double-submit from a retried network call never duplicates history.
export function recordOrder(input: RecordOrderInput): CrossNetworkOrder | null {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const wallet = str(input.wallet, 64);
  const kind = input.kind === "hire" || input.kind === "buy" ? input.kind : null;
  const itemPda = str(input.itemPda, MAX_PDA);
  const name = str(input.name, MAX_NAME) || "(unnamed)";
  const price = str(input.price, MAX_PRICE) || "—";
  const txSig = str(input.txSig, MAX_SIG);
  if (!isValidWallet(wallet) || !kind || !itemPda || !BASE58_SIG.test(txSig)) return null;

  const status = kind === "hire" ? "funded" : "settled";
  const now = new Date().toISOString();
  const db = getDb();
  // idempotent on tx_sig — a repeated record of the same on-chain action is ignored
  db.prepare(
    `INSERT INTO cross_network_orders (wallet, kind, network, item_pda, name, price, tx_sig, status, created_at)
     VALUES (?, ?, 'agenc', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tx_sig) DO NOTHING`,
  ).run(wallet, kind, itemPda, name, price, txSig, status, now);
  return getOrderByTxSig(txSig);
}

export function getOrderByTxSig(txSig: string): CrossNetworkOrder | null {
  const row = getDb()
    .prepare(
      `SELECT id, wallet, kind, network, item_pda AS itemPda, name, price, tx_sig AS txSig, status, created_at AS createdAt
         FROM cross_network_orders WHERE tx_sig = ?`,
    )
    .get(txSig) as CrossNetworkOrder | undefined;
  return row ?? null;
}

// One wallet's full history, newest first. Bounded so a huge history can't blow
// up a response; the panel shows the most recent orders.
export function listOrders(wallet: string, limit = 100): CrossNetworkOrder[] {
  if (!isValidWallet(wallet)) return [];
  return getDb()
    .prepare(
      `SELECT id, wallet, kind, network, item_pda AS itemPda, name, price, tx_sig AS txSig, status, created_at AS createdAt
         FROM cross_network_orders WHERE wallet = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(wallet, Math.min(Math.max(1, limit), 200)) as CrossNetworkOrder[];
}
