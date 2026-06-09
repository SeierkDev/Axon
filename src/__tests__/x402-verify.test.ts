// Tests for verifyX402Payment in x402.ts.
// verifyIncomingPayment is mocked so no Solana RPC call occurs.
// All other x402 functions (encode/decode/build) are already tested in x402.test.ts.

import { vi, describe, it, expect } from "vitest";

const { mockVerifyIncomingPayment } = vi.hoisted(() => ({
  mockVerifyIncomingPayment: vi.fn(),
}));

vi.mock("@/lib/solana", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/solana")>();
  return { ...original, verifyIncomingPayment: mockVerifyIncomingPayment };
});

import { verifyX402Payment, X402_SCHEME } from "@/lib/x402";
import type { X402PaymentHeader } from "@/lib/x402";

const SIGNER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function makeHeader(sig = "fakesig"): X402PaymentHeader {
  return {
    scheme: X402_SCHEME,
    network: "solana-devnet",
    payload: { signature: sig, from: SIGNER },
  };
}

// ── Unrecognised price format ──────────────────────────────────────────────────

describe("verifyX402Payment: unrecognised price format", () => {
  it("returns valid=false when price cannot be parsed", async () => {
    const result = await verifyX402Payment(makeHeader(), "not-a-price");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/unrecognised price format/);
    expect(mockVerifyIncomingPayment).not.toHaveBeenCalled();
  });
});

// ── Non-USDC currency ─────────────────────────────────────────────────────────

describe("verifyX402Payment: SOL price rejected (only USDC supported)", () => {
  it("returns valid=false for SOL-priced agents", async () => {
    const result = await verifyX402Payment(makeHeader(), "0.05 SOL");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Only USDC/);
    expect(mockVerifyIncomingPayment).not.toHaveBeenCalled();
  });
});

// ── On-chain verification fails ───────────────────────────────────────────────

describe("verifyX402Payment: on-chain verification returns false", () => {
  it("returns valid=false when the signature does not verify on-chain", async () => {
    mockVerifyIncomingPayment.mockResolvedValueOnce(false);
    const result = await verifyX402Payment(makeHeader(), "0.10 USDC");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signature did not verify/);
  });
});

// ── On-chain verification succeeds ────────────────────────────────────────────

describe("verifyX402Payment: on-chain verification succeeds", () => {
  it("returns valid=true when the signature verifies on-chain", async () => {
    mockVerifyIncomingPayment.mockResolvedValueOnce(true);
    const result = await verifyX402Payment(makeHeader("5".repeat(88)), "0.10 USDC");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ── Config error propagates ───────────────────────────────────────────────────

describe("verifyX402Payment: config error propagates to caller (503 pattern)", () => {
  it("re-throws errors that contain 'is not set'", async () => {
    mockVerifyIncomingPayment.mockRejectedValueOnce(
      new Error("PAYMENT_RECEIVER_WALLET_ADDRESS is not set")
    );
    await expect(verifyX402Payment(makeHeader(), "0.10 USDC")).rejects.toThrow(
      /is not set/
    );
  });

  it("re-throws errors that contain 'HELIUS'", async () => {
    mockVerifyIncomingPayment.mockRejectedValueOnce(
      new Error("HELIUS_API_KEY is not set")
    );
    await expect(verifyX402Payment(makeHeader(), "0.10 USDC")).rejects.toThrow(
      /HELIUS/
    );
  });
});

// ── Generic network/RPC error → valid=false ───────────────────────────────────

describe("verifyX402Payment: generic RPC error returns valid=false", () => {
  it("returns valid=false (does not throw) for transient RPC errors", async () => {
    mockVerifyIncomingPayment.mockRejectedValueOnce(new Error("Connection timed out"));
    const result = await verifyX402Payment(makeHeader(), "0.10 USDC");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Connection timed out");
  });

  it("uses 'Verification failed' message for non-Error throws", async () => {
    mockVerifyIncomingPayment.mockRejectedValueOnce("raw string error");
    const result = await verifyX402Payment(makeHeader(), "0.10 USDC");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Verification failed");
  });
});
