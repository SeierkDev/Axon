// Client-side Phantom payment for paid Axon Build generations.
// Builds and sends a USDC transfer to the treasury wallet, then returns the
// transaction signature for the server to verify on-chain before generating.

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS = 6;

interface PhantomProvider {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: PublicKey }>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
}

function getPhantom(): PhantomProvider | null {
  const w = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  const provider = w.phantom?.solana ?? w.solana;
  return provider && provider.isPhantom ? provider : null;
}

export interface BuildPaymentResult {
  signature: string;
  payer: string;
}

export async function payForBuild(opts: {
  rpcUrl: string;
  treasury: string;
  usdcAmount: number;
}): Promise<BuildPaymentResult> {
  const provider = getPhantom();
  if (!provider) {
    // Caller decides what to do (mobile → deeplink into Phantom's browser;
    // desktop → prompt to install the extension).
    throw new Error("PHANTOM_NOT_FOUND");
  }

  const { publicKey: payer } = await provider.connect();

  const connection = new Connection(opts.rpcUrl, "confirmed");
  const treasuryPk = new PublicKey(opts.treasury);
  const payerAta = getAssociatedTokenAddressSync(USDC_MINT, payer);
  // allowOwnerOffCurve=true so PDA/multisig treasury addresses resolve correctly.
  const treasuryAta = getAssociatedTokenAddressSync(USDC_MINT, treasuryPk, true);
  const units = BigInt(Math.round(opts.usdcAmount * 10 ** USDC_DECIMALS));

  // Pre-flight: confirm the payer actually holds enough USDC. Otherwise the
  // transfer reverts on-chain with InsufficientFunds, which surfaces to the user
  // as a vague "payment not confirmed" only after they've signed. A missing ATA
  // (never held USDC) reads as a zero balance.
  let payerUsdc = 0;
  try {
    const bal = await connection.getTokenAccountBalance(payerAta);
    payerUsdc = bal.value.uiAmount ?? 0;
  } catch {
    payerUsdc = 0;
  }
  if (payerUsdc < opts.usdcAmount) {
    throw new Error(`INSUFFICIENT_USDC:${payerUsdc}`);
  }

  // If the recipient has never held USDC, their associated token account does
  // not exist yet — a transfer to a missing account reverts on-chain. Create it
  // in the same transaction (the payer covers the ~0.002 SOL rent). The treasury
  // already has one, so Build is unaffected; this only adds an instruction when
  // paying a fresh wallet (e.g. a newly registered agent winning a bid).
  const recipientAtaMissing = (await connection.getAccountInfo(treasuryAta)) === null;

  // The wallet also needs a little SOL to pay the Solana network fee. USDC can't
  // cover it — a wallet with 0 SOL produces a transaction that can never land,
  // which otherwise surfaces as a baffling "transaction not found". When we also
  // create the recipient's token account, budget for its rent on top of the fee.
  const minLamports = recipientAtaMissing ? 3_000_000 : 1_000_000;
  const solLamports = await connection.getBalance(payer);
  if (solLamports < minLamports) {
    throw new Error("INSUFFICIENT_SOL");
  }

  // Keep instructions minimal — Phantom attaches its own priority fee when it
  // sends, and we do NOT add ComputeBudget instructions (they collide with
  // Phantom's and trip its risk scanner). The optional ATA-creation instruction
  // is a standard, expected one that Phantom handles cleanly.
  const tx = new Transaction();
  if (recipientAtaMissing) {
    tx.add(
      createAssociatedTokenAccountInstruction(payer, treasuryAta, treasuryPk, USDC_MINT),
    );
  }
  tx.add(
    createTransferCheckedInstruction(
      payerAta,
      USDC_MINT,
      treasuryAta,
      payer,
      units,
      USDC_DECIMALS,
    ),
  );
  tx.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const { signature } = await provider.signAndSendTransaction(tx);

  // Wait for the transaction to confirm. We poll signature status WITH history
  // search, so a tx that has landed is reliably detected even if the RPC is a
  // beat behind — the previous version gave up on blockhash expiry and
  // false-failed payments that had actually gone through.
  const status = await waitForConfirmation(connection, signature);
  if (status === "failed") {
    // Landed but reverted on-chain (e.g. ran out of funds mid-transfer).
    throw new Error("PAYMENT_FAILED");
  }
  // "confirmed" or "timeout": hand the signature to the server regardless — it
  // re-verifies on-chain and is the source of truth. A slow tx that lands after
  // we time out is still found there (and the same signature is retryable, so no
  // double charge). We never throw away a signature for a payment that may have
  // succeeded.
  return { signature, payer: payer.toBase58() };
}

// Polls signature status until the tx confirms or fails on-chain, or we time out.
// searchTransactionHistory: true so a landed-but-slightly-late tx is still seen.
async function waitForConfirmation(
  connection: Connection,
  signature: string,
): Promise<"confirmed" | "failed" | "timeout"> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const { value } = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      if (value) {
        if (value.err) return "failed";
        if (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized") {
          return "confirmed";
        }
      }
    } catch {
      /* transient RPC hiccup — keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return "timeout";
}
