// The client-side spend cap — the safety rail for autonomous paying. The guard runs
// before any RPC call, so we can assert it refuses to sign an over-cap request without
// touching the network. (The happy path is exercised end-to-end against a live RPC.)

import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { solanaPayer, walletPayer } from "../src/solana";
import type { X402Requirements } from "../src/types";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// A requirements object asking for `usdc` USDC (6 decimals).
function reqFor(usdc: number): X402Requirements {
  return {
    accepts: [
      {
        payToAddress: Keypair.generate().publicKey.toBase58(),
        maxAmountRequired: String(Math.round(usdc * 1e6)),
        asset: USDC,
        extra: { decimals: 6, contractAddress: USDC },
      },
    ],
  } as X402Requirements;
}

describe("solana payer spend cap", () => {
  it("solanaPayer refuses to sign above maxAmountUsdc", async () => {
    const pay = solanaPayer(Keypair.generate(), { maxAmountUsdc: 1 });
    await expect(pay(reqFor(5))).rejects.toThrow(/exceeds the 1 USDC cap/);
  });

  it("walletPayer refuses to sign above maxAmountUsdc", async () => {
    const wallet = { publicKey: Keypair.generate().publicKey };
    const pay = walletPayer(wallet, { maxAmountUsdc: 0.5 });
    await expect(pay(reqFor(2))).rejects.toThrow(/exceeds the 0.5 USDC cap/);
  });

  it("does not fire when the request is within the cap (fails later, at the network)", async () => {
    // 0.25 <= 1, so the cap passes; the call then proceeds to RPC and fails there —
    // proving the guard itself let an in-budget payment through.
    const pay = solanaPayer(Keypair.generate(), { maxAmountUsdc: 1, rpcUrl: "http://127.0.0.1:1" });
    await expect(pay(reqFor(0.25))).rejects.not.toThrow(/exceeds/);
  });

  it("rejects an invalid (negative / non-finite) cap with a clear config error", async () => {
    const neg = solanaPayer(Keypair.generate(), { maxAmountUsdc: -1 });
    await expect(neg(reqFor(0.1))).rejects.toThrow(/invalid maxAmountUsdc/);
    const nan = solanaPayer(Keypair.generate(), { maxAmountUsdc: Number.NaN });
    await expect(nan(reqFor(0.1))).rejects.toThrow(/invalid maxAmountUsdc/);
  });
});
