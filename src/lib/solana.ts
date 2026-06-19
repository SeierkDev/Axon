import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { logger } from "./logger";

// Payment receiver — x402/MPP requirements tell callers to send USDC here.
export const PAYMENT_RECEIVER_WALLET_ADDRESS =
  process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ??
  process.env.NEXT_PUBLIC_WALLET_ADDRESS ??
  "";

// USDC mint on Solana mainnet
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// USDC has 6 decimal places
export const USDC_DECIMALS = 6;

// ── Connection ────────────────────────────────────────────────────────────────

function getHeliusUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY is not set");
  const network = process.env.SOLANA_NETWORK === "devnet" ? "devnet" : "mainnet";
  return `https://${network}.helius-rpc.com/?api-key=${key}`;
}

export function getConnection(): Connection {
  return new Connection(getHeliusUrl(), "confirmed");
}

// ── Circuit breaker for Helius RPC ────────────────────────────────────────────
// After 5 consecutive failures the circuit opens and all Helius calls fail fast
// for 60 s. After that window, one probe is allowed. On success the circuit
// closes; on failure the recovery window restarts.

const HELIUS_FAILURE_THRESHOLD = 5;
const HELIUS_RECOVERY_WINDOW_MS = 60_000;
const HELIUS_MAX_RETRIES = 3;
const HELIUS_BASE_DELAY_MS = 300;

type CircuitState = "closed" | "open" | "half-open";

interface HeliusCircuit {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

const _helius: HeliusCircuit = { state: "closed", failures: 0, openedAt: null };

export function isTransientHeliusError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (/econnreset|etimedout/i.test(msg)) return true;
  return /\b(429|502|503|504)\b/.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Helius circuit is open — retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

function advanceCircuitState(): CircuitState {
  if (_helius.state === "open" && _helius.openedAt !== null) {
    if (Date.now() - _helius.openedAt >= HELIUS_RECOVERY_WINDOW_MS) {
      _helius.state = "half-open";
      // Reset so consecutiveFailures reflects only the probe result, not the
      // accumulated pre-open failures (which are irrelevant once we probe).
      _helius.failures = 0;
    }
  }
  return _helius.state;
}

export async function withHelius<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  const state = advanceCircuitState();
  if (state === "open") {
    const retryAfterMs = HELIUS_RECOVERY_WINDOW_MS - (Date.now() - _helius.openedAt!);
    throw new CircuitOpenError(Math.max(0, retryAfterMs));
  }

  // In half-open state allow only one probe — no retries, to avoid delaying recovery
  const maxAttempts = state === "half-open" ? 1 : HELIUS_MAX_RETRIES;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const jitter = 0.8 + Math.random() * 0.4; // ±20%
      const delay = Math.min(HELIUS_BASE_DELAY_MS * (2 ** (attempt - 1)) * jitter, 8_000);
      await sleep(delay);
    }
    try {
      const result = await fn(getConnection());
      _helius.state = "closed";
      _helius.failures = 0;
      _helius.openedAt = null;
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientHeliusError(err) || attempt === maxAttempts - 1) break;
    }
  }

  // All attempts exhausted — counts as one failure toward the circuit threshold
  _helius.failures++;
  if (_helius.state === "half-open" || _helius.failures >= HELIUS_FAILURE_THRESHOLD) {
    const alreadyOpen = _helius.state === "open";
    _helius.state = "open";
    _helius.openedAt = Date.now();
    if (!alreadyOpen) {
      logger.error("helius.circuit_opened", "Helius circuit breaker opened — Solana RPC is failing", {
        consecutiveFailures: _helius.failures,
        recoveryWindowMs: HELIUS_RECOVERY_WINDOW_MS,
      });
    }
  }
  throw lastErr;
}

export function getHeliusCircuitState(): { state: CircuitState; consecutiveFailures: number } {
  advanceCircuitState();
  return { state: _helius.state, consecutiveFailures: _helius.failures };
}

export function resetHeliusCircuit(): void {
  _helius.state = "closed";
  _helius.failures = 0;
  _helius.openedAt = null;
}

// ── Address validation ────────────────────────────────────────────────────────

export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// ── Amount helpers ────────────────────────────────────────────────────────────

export type Currency = "SOL" | "USDC";

export interface ParsedPayment {
  amount: number;
  currency: Currency;
  units: bigint;
}

function decimalToUnits(raw: string, decimals: number): bigint | null {
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > decimals) return null;
  const units = BigInt(whole) * (BigInt(10) ** BigInt(decimals)) +
    BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return units > BigInt(0) ? units : null;
}

export function parseUsdcAmount(amount: unknown): { amount: number; units: bigint } | null {
  const raw = typeof amount === "number"
    ? (Number.isFinite(amount) ? String(amount) : "")
    : typeof amount === "string"
      ? amount.trim()
      : "";
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) return null;

  const units = decimalToUnits(raw, USDC_DECIMALS);
  if (units === null) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? { amount: parsed, units } : null;
}

// Parses "0.05 SOL" or "5 USDC" — returns null if unrecognised
export function parsePaymentAmount(price: string): ParsedPayment | null {
  const solMatch = price.trim().match(/^(\d+(?:\.\d{1,9})?)\s*SOL$/i);
  if (solMatch) {
    const units = decimalToUnits(solMatch[1], 9);
    if (units === null) return null;
    const amount = Number(solMatch[1]);
    return Number.isFinite(amount) && amount > 0 ? { amount, currency: "SOL", units } : null;
  }

  const usdcMatch = price.trim().match(/^(\d+(?:\.\d{1,6})?)\s*USDC$/i);
  if (usdcMatch) {
    const units = decimalToUnits(usdcMatch[1], USDC_DECIMALS);
    if (units === null) return null;
    const amount = Number(usdcMatch[1]);
    return Number.isFinite(amount) && amount > 0 ? { amount, currency: "USDC", units } : null;
  }

  return null;
}

function paymentAmountToUnits(expected: ParsedPayment): bigint {
  return expected.units;
}

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

export function formatSol(sol: number): string {
  return `${sol.toFixed(4)} SOL`;
}

// ── Verify incoming payment ───────────────────────────────────────────────────
// Verifies SOL or USDC payment reached PAYMENT_RECEIVER_WALLET_ADDRESS on-chain.

// Thin boolean wrapper kept for existing callers (x402, mpp, payments).
export async function verifyIncomingPayment(
  signature: string,
  expected: ParsedPayment,
  expectedSigner?: string
): Promise<boolean> {
  return (await checkIncomingPayment(signature, expected, expectedSigner)).ok;
}

// Same verification as verifyIncomingPayment, but returns WHY it failed so
// callers (e.g. the Build payment gate) can surface an actionable reason
// instead of a generic "not confirmed".
export async function checkIncomingPayment(
  signature: string,
  expected: ParsedPayment,
  expectedSigner?: string
): Promise<{ ok: boolean; reason: string }> {
  if (!PAYMENT_RECEIVER_WALLET_ADDRESS) {
    throw new Error("PAYMENT_RECEIVER_WALLET_ADDRESS is not set");
  }

  if (process.env.AXON_PAYMENT_VERIFIER === "mock") {
    const ok = verifyMockIncomingPayment(signature, expected, expectedSigner);
    return { ok, reason: ok ? "ok" : "mock verification failed" };
  }

  // getTransaction lags signature confirmation by a few seconds: the client
  // confirms the signature and immediately submits, but the RPC often can't
  // return the full transaction yet (it returns null). Poll briefly instead of
  // failing on the first miss — otherwise a perfectly good payment 402s.
  let tx: Awaited<ReturnType<Connection["getTransaction"]>> = null;
  const ATTEMPTS = 16;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    tx = await withHelius(conn => conn.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }));
    if (tx) break;
    if (attempt < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2000));
  }

  if (!tx) return { ok: false, reason: "transaction not found on-chain (not yet confirmed, or wrong signature/RPC)" };
  if (!tx.meta || tx.meta.err) return { ok: false, reason: "transaction failed on-chain" };
  if (expectedSigner && !transactionHasSigner(tx, expectedSigner)) {
    return { ok: false, reason: "transaction was not signed by the expected payer" };
  }
  const expectedUnits = paymentAmountToUnits(expected);
  if (expectedUnits <= BigInt(0)) return { ok: false, reason: "expected payment amount is invalid" };

  if (expected.currency === "SOL") {
    const keys =
      "staticAccountKeys" in tx.transaction.message
        ? tx.transaction.message.staticAccountKeys
        : (tx.transaction.message as { accountKeys: PublicKey[] }).accountKeys;

    const walletIdx = keys.findIndex((k) => k.toBase58() === PAYMENT_RECEIVER_WALLET_ADDRESS);
    if (walletIdx === -1) return { ok: false, reason: "treasury wallet is not a participant in the transaction" };

    const lamportsReceived = BigInt(
      (tx.meta.postBalances[walletIdx] ?? 0) - (tx.meta.preBalances[walletIdx] ?? 0)
    );
    if (lamportsReceived >= expectedUnits) return { ok: true, reason: "ok" };
    return { ok: false, reason: `received ${lamportsReceived} lamports, expected ${expectedUnits}` };
  }

  // USDC: look up by the receiver's ATA account index rather than by owner field.
  // The owner field is unreliable when the ATA is created in the same transaction.
  const walletPk = new PublicKey(PAYMENT_RECEIVER_WALLET_ADDRESS);
  const usdcMintPk = new PublicKey(USDC_MINT);
  // allowOwnerOffCurve=true so PDAs and multisig wallets work as receiver addresses
  const receiverAta = getAssociatedTokenAddressSync(usdcMintPk, walletPk, true);
  const receiverAtaStr = receiverAta.toBase58();

  const txKeys =
    "staticAccountKeys" in tx.transaction.message
      ? tx.transaction.message.staticAccountKeys
      : (tx.transaction.message as { accountKeys: PublicKey[] }).accountKeys;

  const ataIndex = txKeys.findIndex((k) => k.toBase58() === receiverAtaStr);
  if (ataIndex === -1) {
    return { ok: false, reason: "treasury USDC account not in transaction (wrong treasury address, or no USDC was sent)" };
  }

  const preTokenBalances = tx.meta.preTokenBalances ?? [];
  const postTokenBalances = tx.meta.postTokenBalances ?? [];

  const preAmount =
    preTokenBalances.find((b) => b.accountIndex === ataIndex && b.mint === USDC_MINT)
      ?.uiTokenAmount.amount ?? "0";

  const postAmount =
    postTokenBalances.find((b) => b.accountIndex === ataIndex && b.mint === USDC_MINT)
      ?.uiTokenAmount.amount ?? "0";

  const received = BigInt(postAmount) - BigInt(preAmount);
  if (received >= expectedUnits) return { ok: true, reason: "ok" };
  return { ok: false, reason: `received ${received} USDC units, expected ${expectedUnits} (mint match required)` };
}

function verifyMockIncomingPayment(
  signature: string,
  expected: ParsedPayment,
  expectedSigner?: string
): boolean {
  const parts = signature.split(":");
  if (parts.length !== 6 || parts[0] !== "mockpay") return false;

  const [, currency, unitsRaw, signer, receiver] = parts;
  if (currency !== expected.currency) return false;
  if (expectedSigner && signer !== expectedSigner) return false;
  if (receiver !== PAYMENT_RECEIVER_WALLET_ADDRESS) return false;

  try {
    return BigInt(unitsRaw) >= expected.units;
  } catch {
    return false;
  }
}

function transactionHasSigner(
  tx: Awaited<ReturnType<Connection["getTransaction"]>>,
  signerAddress: string
): boolean {
  if (!tx) return false;

  const message = tx.transaction.message;
  const keys =
    "staticAccountKeys" in message
      ? message.staticAccountKeys
      : (message as { accountKeys: PublicKey[] }).accountKeys;
  const requiredSignatures =
    "header" in message && typeof message.header?.numRequiredSignatures === "number"
      ? message.header.numRequiredSignatures
      : 0;

  return keys
    .slice(0, requiredSignatures)
    .some((key) => key.toBase58() === signerAddress);
}

// ── Send USDC refund ──────────────────────────────────────────────────────────
// Transfers USDC from the payment receiver wallet back to a recipient address.
// Optional: only needed for automatic refunds of funded MPP channels.
// Requires REFUND_SIGNER_PRIVATE_KEY in env — a JSON array of 64 bytes matching PAYMENT_RECEIVER_WALLET_ADDRESS.
// Example: REFUND_SIGNER_PRIVATE_KEY='[1,2,3,...,64]'  (solana-keygen output format)
// Throws for config errors (caller should return 503) or tx failures (caller returns 500).

export async function sendUsdcRefund(
  toAddress: string,
  amountUsdc: number
): Promise<string> {
  const rawKey = process.env.REFUND_SIGNER_PRIVATE_KEY;
  if (!rawKey) throw new Error("REFUND_SIGNER_PRIVATE_KEY is not set");
  if (!PAYMENT_RECEIVER_WALLET_ADDRESS) {
    throw new Error("PAYMENT_RECEIVER_WALLET_ADDRESS is not set");
  }

  let secretKey: Uint8Array;
  try {
    secretKey = Uint8Array.from(JSON.parse(rawKey) as number[]);
  } catch {
    throw new Error("REFUND_SIGNER_PRIVATE_KEY must be a JSON array of 64 bytes, e.g. [1,2,...,64]");
  }

  const payer = Keypair.fromSecretKey(secretKey);
  if (payer.publicKey.toBase58() !== PAYMENT_RECEIVER_WALLET_ADDRESS) {
    throw new Error("REFUND_SIGNER_PRIVATE_KEY does not match PAYMENT_RECEIVER_WALLET_ADDRESS — refund aborted to prevent loss of funds");
  }

  const mintPubkey = new PublicKey(USDC_MINT);
  const toPubkey = new PublicKey(toAddress);

  const fromAta = getAssociatedTokenAddressSync(mintPubkey, payer.publicKey, true);
  const toAta = getAssociatedTokenAddressSync(mintPubkey, toPubkey, true);

  // Use BigInt for lamport-level precision
  const parsedAmount = parseUsdcAmount(amountUsdc);
  if (!parsedAmount) throw new Error("Refund amount must be a positive USDC amount with at most 6 decimals");
  const microUsdc = parsedAmount.units;

  const tx = new Transaction().add(
    // Create destination ATA if it doesn't exist yet — idempotent, safe to include always
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      toAta,
      toPubkey,
      mintPubkey
    ),
    createTransferCheckedInstruction(
      fromAta,
      mintPubkey,
      toAta,
      payer.publicKey,
      microUsdc,
      USDC_DECIMALS
    )
  );

  return withHelius(conn => sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
  }));
}

// ── Memo transactions ─────────────────────────────────────────────────────────
// Posts an arbitrary UTF-8 string to Solana via the standard Memo program.
// Signed by the REFUND_SIGNER_PRIVATE_KEY keypair (same wallet that receives payments).
// Throws if the keypair is missing or the transaction fails.

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export async function postMemoTransaction(memo: string): Promise<string> {
  const rawKey = process.env.REFUND_SIGNER_PRIVATE_KEY;
  if (!rawKey) throw new Error("REFUND_SIGNER_PRIVATE_KEY is not set");

  const secretKey = Uint8Array.from(JSON.parse(rawKey) as number[]);
  const payer = Keypair.fromSecretKey(secretKey);

  const instruction = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8"),
  });

  const tx = new Transaction().add(instruction);
  return withHelius(conn => sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" }));
}
