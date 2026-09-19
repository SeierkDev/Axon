// Paying for a generation from the browser, with the visitor's own wallet.
//
// A native ETH transfer to the treasury, sent through the injected wallet. The server re-verifies
// the hash on-chain before it generates anything, so this is a convenience for the payer rather
// than a source of truth.
//
// Most of what the Solana version needed is simply gone: there are no associated token accounts to
// create, no separate fee currency to hold, and no blockhash to expire. What is left is the part
// that always mattered — check the balance BEFORE asking anyone to sign, and never throw away a
// hash for a payment that might have landed.

import { parseEther, formatEther } from "viem";
import { provider, isPhone, metaMaskDeepLink, type Eip1193 } from "./chain";
import { normalizeAddress } from "./address";

export interface BuildPaymentResult {
  signature: string;
  payer: string;
}

const hex = (v: bigint) => `0x${v.toString(16)}`;

export async function payForBuild(opts: {
  rpcUrl?: string;
  treasury: string;
  ethAmount: number | string;
}): Promise<BuildPaymentResult> {
  const p: Eip1193 | null = provider();
  if (!p) {
    // A phone has the wallet as an app, not an extension, so the way in is its own browser.
    const coarse =
      typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false);
    if (typeof navigator !== "undefined" && isPhone(navigator.userAgent, coarse)) {
      window.location.href = metaMaskDeepLink(window.location.href);
      return new Promise<BuildPaymentResult>(() => {});
    }
    throw new Error("WALLET_NOT_FOUND");
  }

  const treasury = normalizeAddress(opts.treasury);
  if (!treasury) throw new Error("TREASURY_NOT_CONFIGURED");

  const value = parseEther(String(opts.ethAmount));
  if (value <= 0n) throw new Error("INVALID_AMOUNT");

  const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
  const payer = accounts?.[0];
  if (!payer) throw new Error("WALLET_NOT_FOUND");

  // Check the balance before asking for a signature. Otherwise the transaction fails after the
  // visitor has already approved it, and surfaces as a vague "payment not confirmed".
  const balance = BigInt(
    (await p.request({ method: "eth_getBalance", params: [payer, "latest"] })) as string,
  );
  if (balance < value) {
    throw new Error(`INSUFFICIENT_FUNDS:${formatEther(balance)}`);
  }

  const signature = (await p.request({
    method: "eth_sendTransaction",
    params: [{ from: payer, to: treasury, value: hex(value) }],
  })) as string;

  // Wait for it to land, but hand the hash back either way: the server re-verifies on-chain and is
  // the source of truth, and the same hash is retryable, so a slow transaction is never lost and
  // nobody pays twice for having waited.
  await waitForReceipt(p, signature);
  return { signature, payer: payer.toLowerCase() };
}

/** Polls for a receipt. Throws only when the chain says the transaction actually failed. */
async function waitForReceipt(p: Eip1193, hash: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const receipt = (await p.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      })) as { status?: string } | null;
      if (receipt) {
        if (BigInt(receipt.status ?? "0x0") !== 1n) throw new Error("PAYMENT_FAILED");
        return;
      }
    } catch (e) {
      if (e instanceof Error && e.message === "PAYMENT_FAILED") throw e;
      /* a transient read is not a verdict — keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // Timed out without a verdict. The caller still submits the hash and the server decides.
}
