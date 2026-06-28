import { describe, it, expect } from "vitest";
import { isTransientPaymentError } from "@/lib/payments";
import { CircuitOpenError } from "@/lib/solana";

describe("isTransientPaymentError", () => {
  it("treats a circuit-open error as transient", () => {
    expect(isTransientPaymentError(new CircuitOpenError(5000))).toBe(true);
  });

  it("treats a .transient-tagged error as transient", () => {
    const e = Object.assign(new Error("Payment not verified (transaction not found on-chain)"), { transient: true });
    expect(isTransientPaymentError(e)).toBe(true);
  });

  it("treats infra/config errors (missing key) as transient", () => {
    expect(isTransientPaymentError(new Error("HELIUS RPC API_KEY is not set"))).toBe(true);
  });

  it("treats a genuine rejection (wrong signer) as NOT transient", () => {
    const e = Object.assign(
      new Error("Payment not verified on-chain. Expected 0.05 USDC signed by X (transaction was not signed by the expected payer)"),
      { transient: false }
    );
    expect(isTransientPaymentError(e)).toBe(false);
  });

  it("treats a tx-failed rejection as NOT transient", () => {
    const e = Object.assign(new Error("Payment not verified on-chain (transaction failed on-chain)"), { transient: false });
    expect(isTransientPaymentError(e)).toBe(false);
  });

  it("treats a non-error value as not transient", () => {
    expect(isTransientPaymentError("nope")).toBe(false);
    expect(isTransientPaymentError(null)).toBe(false);
  });
});
