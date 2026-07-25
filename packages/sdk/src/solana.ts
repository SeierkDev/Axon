// Optional Solana payment adapter for the Axon SDK.
//
// Turns a wallet into an `X402PayFunction`, so paid hires *just pay* — no more
// hand-writing the USDC transfer. Import from the `/solana` subpath so the core
// SDK stays dependency-free; this pulls @solana/web3.js + @solana/spl-token.
//
//   import { AxonClient } from "@axonprotocol/sdk";
//   import { solanaPayer } from "@axonprotocol/sdk/solana";
//
//   const axon = new AxonClient({ pay: solanaPayer(secretKey, { rpcUrl }) });
//   await axon.hire({ to: "research-agent", task: "…" }); // paid? it pays + retries.
//
// The transfer is congestion-hardened: a dynamic priority fee (75th-percentile of
// recent network fees, clamped) plus rebroadcast of the same signed transaction
// until it confirms or the blockhash truly expires — the same reliability the Axon
// server uses for its own payments.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { X402PayFunction, X402Requirements } from "./types";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const PRIORITY_FEE_FLOOR = 10_000; // micro-lamports/CU
const PRIORITY_FEE_CEIL = 1_000_000;
const COMPUTE_UNIT_LIMIT = 60_000;
const CONFIRM_HARD_DEADLINE_MS = 120_000;

export interface SolanaPayerOptions {
  /** RPC endpoint. Default: mainnet-beta public RPC (use your own for production). */
  rpcUrl?: string;
  /** Fixed priority fee in micro-lamports/CU. Omit for a dynamic, clamped fee. */
  priorityFeeMicroLamports?: number;
  /**
   * Hard per-payment spend cap, in USDC. If a listing's requested amount exceeds
   * this, the payer refuses to sign — nothing is sent. Set this whenever an
   * autonomous agent pays on its own, so a malicious or buggy listing can't drain
   * the wallet. Omit for no cap (the payer trusts the requested amount).
   */
  maxAmountUsdc?: number;
}

/**
 * Guard the requested amount against `maxAmountUsdc` before signing. `amount` is in
 * base units; `decimals` is the asset's decimals (USDC = 6). Throws (nothing is sent)
 * if the request exceeds the cap.
 */
function assertWithinCap(amount: bigint, decimals: number, opts: SolanaPayerOptions): void {
  if (opts.maxAmountUsdc == null) return;
  if (!Number.isFinite(opts.maxAmountUsdc) || opts.maxAmountUsdc < 0) {
    throw new Error(`invalid maxAmountUsdc: ${opts.maxAmountUsdc} — must be a non-negative number`);
  }
  const d = Number.isFinite(decimals) ? decimals : 6; // USDC fallback if a listing omits decimals
  const capBaseUnits = BigInt(Math.round(opts.maxAmountUsdc * 10 ** d));
  if (amount > capBaseUnits) {
    const requested = Number(amount) / 10 ** d;
    throw new Error(
      `payment of ${requested} USDC exceeds the ${opts.maxAmountUsdc} USDC cap — refusing to sign (no funds moved)`,
    );
  }
}

/** Accepts a Keypair, a 64-byte secret key, or a JSON byte array. */
export type SolanaSigner = Keypair | Uint8Array | number[];

function toKeypair(signer: SolanaSigner): Keypair {
  if (signer instanceof Keypair) return signer;
  return Keypair.fromSecretKey(signer instanceof Uint8Array ? signer : Uint8Array.from(signer));
}

async function dynamicPriorityFee(conn: Connection): Promise<number> {
  try {
    const recent = await conn.getRecentPrioritizationFees();
    const fees = recent.map((r) => r.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
    if (fees.length === 0) return PRIORITY_FEE_FLOOR;
    const p = fees[Math.floor(fees.length * 0.75)] ?? PRIORITY_FEE_FLOOR;
    return Math.min(PRIORITY_FEE_CEIL, Math.max(PRIORITY_FEE_FLOOR, p));
  } catch {
    return PRIORITY_FEE_FLOOR;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Send a signed tx and keep rebroadcasting the same bytes while polling for
// confirmation. Resolves on confirmation; throws only when the blockhash truly
// expires with nothing landed (no funds moved), or the tx errors on-chain.
async function sendWithRebroadcast(
  conn: Connection,
  rawTx: Buffer | Uint8Array,
  lastValidBlockHeight: number,
): Promise<string> {
  const signature = await conn.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 0 });
  let lastRebroadcast = Date.now();
  const startedAt = Date.now();
  for (;;) {
    let value: Awaited<ReturnType<Connection["getSignatureStatus"]>>["value"] = null;
    try {
      ({ value } = await conn.getSignatureStatus(signature, { searchTransactionHistory: false }));
    } catch {
      await sleep(1000);
      continue;
    }
    if (value?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(value.err)}`);
    if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
      return signature;
    }

    let height = 0;
    try { height = await conn.getBlockHeight("confirmed"); } catch { /* transient */ }
    if (height > lastValidBlockHeight) {
      const final = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (final.value?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(final.value.err)}`);
      if (final.value) return signature; // landed in the final valid block — funds moved
      throw new Error("blockhash expired before confirmation (network congestion) — no funds moved");
    }
    if (Date.now() - startedAt > CONFIRM_HARD_DEADLINE_MS) {
      const final = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (final.value?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(final.value.err)}`);
      if (final.value) return signature;
      throw new Error("payment confirmation could not be verified (RPC unreachable) — check the wallet before retrying");
    }
    if (Date.now() - lastRebroadcast >= 2000) {
      try { await conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }); } catch { /* keep waiting */ }
      lastRebroadcast = Date.now();
    }
    await sleep(1000);
  }
}

/**
 * Build an `X402PayFunction` from a Solana wallet. Pass it to `AxonClient({ pay })`
 * or to `hire({ pay })`, and paid hires settle their USDC automatically.
 */
export function solanaPayer(signer: SolanaSigner, opts: SolanaPayerOptions = {}): X402PayFunction {
  const keypair = toKeypair(signer);
  const conn = new Connection(opts.rpcUrl ?? DEFAULT_RPC_URL, "confirmed");

  return async (requirements: X402Requirements) => {
    const option = requirements.accepts[0];
    if (!option) throw new Error("x402 requirements carried no payment option");

    const recipient = new PublicKey(option.payToAddress);
    const mint = new PublicKey(option.extra.contractAddress || option.asset);
    const decimals = option.extra.decimals;
    const amount = BigInt(option.maxAmountRequired);
    assertWithinCap(amount, decimals, opts);

    const fromAta = getAssociatedTokenAddressSync(mint, keypair.publicKey, true);
    const toAta = getAssociatedTokenAddressSync(mint, recipient, true);

    const priorityFee = opts.priorityFeeMicroLamports ?? (await dynamicPriorityFee(conn));
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, toAta, recipient, mint),
      createTransferCheckedInstruction(fromAta, mint, toAta, keypair.publicKey, amount, decimals),
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = keypair.publicKey;
    tx.sign(keypair);

    const signature = await sendWithRebroadcast(conn, tx.serialize(), lastValidBlockHeight);
    return { signature, from: keypair.publicKey.toBase58() };
  };
}

/**
 * A connected browser wallet — the @solana/wallet-adapter shape (`sendTransaction`)
 * or a Phantom-style provider (`signAndSendTransaction`). Either is accepted.
 */
export interface WalletLike {
  publicKey: PublicKey | null;
  sendTransaction?: (transaction: Transaction, connection: Connection) => Promise<string>;
  signAndSendTransaction?: (transaction: Transaction) => Promise<{ signature: string }>;
}

async function confirmViaStatus(conn: Connection, signature: string): Promise<void> {
  // Poll status WITH history search so a landed-but-slightly-late tx is still seen, and
  // never false-fail on blockhash expiry — the Axon server re-verifies the signature and
  // is the source of truth, so a slow-but-successful payment is never thrown away.
  const deadline = Date.now() + CONFIRM_HARD_DEADLINE_MS;
  for (;;) {
    let value: Awaited<ReturnType<Connection["getSignatureStatus"]>>["value"] = null;
    try { ({ value } = await conn.getSignatureStatus(signature, { searchTransactionHistory: true })); } catch { /* transient */ }
    if (value?.err) throw new Error(`payment failed on-chain: ${JSON.stringify(value.err)}`);
    if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) return;
    if (Date.now() > deadline) return; // hand the signature over regardless — the server re-verifies
    await sleep(1000);
  }
}

/**
 * Build an `X402PayFunction` from a connected browser wallet (Phantom, Solflare,
 * any @solana/wallet-adapter wallet). Use this in a dapp instead of `solanaPayer`,
 * which needs a raw key. No ComputeBudget instructions are added — the wallet
 * attaches its own priority fee and broadcasts.
 */
export function walletPayer(wallet: WalletLike, opts: SolanaPayerOptions = {}): X402PayFunction {
  const conn = new Connection(opts.rpcUrl ?? DEFAULT_RPC_URL, "confirmed");

  return async (requirements: X402Requirements) => {
    if (!wallet.publicKey) throw new Error("wallet is not connected");
    const option = requirements.accepts[0];
    if (!option) throw new Error("x402 requirements carried no payment option");

    const payer = wallet.publicKey;
    const recipient = new PublicKey(option.payToAddress);
    const mint = new PublicKey(option.extra.contractAddress || option.asset);
    const amount = BigInt(option.maxAmountRequired);
    assertWithinCap(amount, option.extra.decimals, opts);

    const fromAta = getAssociatedTokenAddressSync(mint, payer, true);
    const toAta = getAssociatedTokenAddressSync(mint, recipient, true);

    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer, toAta, recipient, mint),
      createTransferCheckedInstruction(fromAta, mint, toAta, payer, amount, option.extra.decimals),
    );
    tx.feePayer = payer;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;

    let signature: string;
    if (wallet.sendTransaction) {
      signature = await wallet.sendTransaction(tx, conn);
    } else if (wallet.signAndSendTransaction) {
      ({ signature } = await wallet.signAndSendTransaction(tx));
    } else {
      throw new Error("wallet must implement sendTransaction or signAndSendTransaction");
    }

    await confirmViaStatus(conn, signature);
    return { signature, from: payer.toBase58() };
  };
}

/** The wallet address (base58) a signer will pay from — handy for logging or `from`. */
export function payerAddress(signer: SolanaSigner): string {
  return toKeypair(signer).publicKey.toBase58();
}
