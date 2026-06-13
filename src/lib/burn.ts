// $AXON token burn — swaps accumulated USDC from platform agent payments into $AXON via Jupiter
// and burns the resulting tokens by sending them to the Solana burn address.
// Called by the daily /api/cron/burn endpoint.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createBurnCheckedInstruction,
  getAccount,
} from "@solana/spl-token";
import { getDb } from "./db";
import { logger } from "./logger";
import { PAYMENT_RECEIVER_WALLET_ADDRESS, USDC_MINT, USDC_DECIMALS } from "./solana";

// $AXON token mint
const AXON_MINT = "6qeQe1LS5yXigxJLUavNmFdbLWbcKLFgnUjqPSpopump";
const AXON_DECIMALS = 6;

// Minimum USDC to trigger a burn — skip if below to avoid wasting gas
const MIN_BURN_USDC = 1.0;

function getConnection(): Connection {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) throw new Error("HELIUS_API_KEY is not set");
  return new Connection(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, "confirmed");
}

function getSigner(): Keypair {
  const rawKey = process.env.REFUND_SIGNER_PRIVATE_KEY;
  if (!rawKey) throw new Error("REFUND_SIGNER_PRIVATE_KEY is not set");
  const secretKey = Uint8Array.from(JSON.parse(rawKey) as number[]);
  const keypair = Keypair.fromSecretKey(secretKey);
  if (keypair.publicKey.toBase58() !== PAYMENT_RECEIVER_WALLET_ADDRESS) {
    throw new Error("REFUND_SIGNER_PRIVATE_KEY does not match PAYMENT_RECEIVER_WALLET_ADDRESS");
  }
  return keypair;
}

export interface BurnResult {
  skipped: boolean;
  reason?: string;
  pendingUsdc: number;
  axonReceived?: number;
  swapSignature?: string;
  burnSignature?: string;
  txIds: string[];
}

export async function executeDailyBurn(): Promise<BurnResult> {
  const db = getDb();

  // Sum all pending burn transactions (USDC only)
  const pending = db.prepare(`
    SELECT tx_id, amount_sol FROM transactions
    WHERE burn_status = 'pending' AND currency = 'USDC'
  `).all() as { tx_id: string; amount_sol: number }[];

  const pendingUsdc = pending.reduce((sum, r) => sum + r.amount_sol, 0);
  const txIds = pending.map((r) => r.tx_id);

  if (pendingUsdc < MIN_BURN_USDC) {
    // Mark as skipped so they carry over — they'll be picked up next run
    logger.info("burn.skipped", "Daily burn skipped — below threshold", { pendingUsdc, min: MIN_BURN_USDC });
    return { skipped: true, reason: `Below minimum threshold ($${MIN_BURN_USDC} USDC)`, pendingUsdc, txIds };
  }

  const conn = getConnection();
  const signer = getSigner();
  const microUsdc = Math.floor(pendingUsdc * 10 ** USDC_DECIMALS);

  // ── Step 1: Jupiter swap USDC → $AXON ──────────────────────────────────────
  let axonReceived = 0;
  let swapSignature = "";

  try {
    // Get quote from Jupiter
    const quoteRes = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${USDC_MINT}&outputMint=${AXON_MINT}&amount=${microUsdc}&slippageBps=300`,
      { signal: AbortSignal.timeout(15_000) }
    );
    if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
    const quote = await quoteRes.json();

    // Get swap transaction from Jupiter
    const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!swapRes.ok) throw new Error(`Jupiter swap failed: ${swapRes.status}`);
    const { swapTransaction } = await swapRes.json();

    // Deserialize and sign the versioned transaction
    const swapTxBuf = Buffer.from(swapTransaction, "base64");
    const vTx = VersionedTransaction.deserialize(swapTxBuf);
    vTx.sign([signer]);

    // Fetch fresh blockhash for reliable confirmation strategy
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    swapSignature = await conn.sendRawTransaction(vTx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction({ signature: swapSignature, blockhash, lastValidBlockHeight }, "confirmed");

    axonReceived = Number(quote.outAmount) / 10 ** AXON_DECIMALS;
    logger.info("burn.swapped", "Swapped USDC for $AXON", { pendingUsdc, axonReceived, swapSignature });
  } catch (err) {
    logger.error("burn.swap_failed", "Jupiter swap failed — burn aborted", { err, pendingUsdc });
    throw err;
  }

  // ── Step 2: Burn all $AXON tokens in the treasury wallet ───────────────────
  let burnSignature = "";
  try {
    const axonMintPubkey = new PublicKey(AXON_MINT);
    const ata = getAssociatedTokenAddressSync(axonMintPubkey, signer.publicKey, true);

    // Get actual token balance (may be slightly different from quote due to slippage)
    const tokenAccount = await getAccount(conn, ata);
    const burnAmount = tokenAccount.amount;

    const burnTx = new Transaction().add(
      createBurnCheckedInstruction(
        ata,
        axonMintPubkey,
        signer.publicKey,
        burnAmount,
        AXON_DECIMALS
      )
    );

    burnSignature = await sendAndConfirmTransaction(conn, burnTx, [signer], { commitment: "confirmed" });
    logger.info("burn.burned", "$AXON burned", { burnAmount: burnAmount.toString(), burnSignature });
  } catch (err) {
    logger.error("burn.burn_failed", "Token burn failed after swap", { err, swapSignature });
    throw err;
  }

  // ── Step 3: Mark transactions as burned ────────────────────────────────────
  const updateStmt = db.prepare("UPDATE transactions SET burn_status = 'burned' WHERE tx_id = ?");
  db.transaction(() => {
    for (const txId of txIds) updateStmt.run(txId);
  })();

  logger.info("burn.complete", "Daily $AXON burn complete", { pendingUsdc, axonReceived, swapSignature, burnSignature });

  return { skipped: false, pendingUsdc, axonReceived, swapSignature, burnSignature, txIds };
}

export function getBurnStats(): { totalBurnedUsdc: number; totalBurns: number; pendingUsdc: number } {
  const db = getDb();
  const burned = db.prepare(`
    SELECT COALESCE(SUM(amount_sol), 0) AS total, COUNT(*) AS count
    FROM transactions WHERE burn_status = 'burned' AND currency = 'USDC'
  `).get() as { total: number; count: number };
  const pending = db.prepare(`
    SELECT COALESCE(SUM(amount_sol), 0) AS total
    FROM transactions WHERE burn_status = 'pending' AND currency = 'USDC'
  `).get() as { total: number };

  return {
    totalBurnedUsdc: Math.round(burned.total * 100) / 100,
    totalBurns: burned.count,
    pendingUsdc: Math.round(pending.total * 100) / 100,
  };
}
