// Tests for solana.ts pure utility functions.
// verifyIncomingPayment is tested via the AXON_PAYMENT_VERIFIER=mock path
// so no real Solana RPC calls are made.
// withHelius / circuit breaker are already tested in solana.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isValidSolanaAddress,
  parsePaymentAmount,
  parseUsdcAmount,
  formatSol,
  solToLamports,
  lamportsToSol,
  verifyIncomingPayment,
} from "@/lib/solana";

// A known-valid mainnet Solana address (SystemProgram — always valid)
const VALID_ADDR = "11111111111111111111111111111111";

// ── isValidSolanaAddress ──────────────────────────────────────────────────────

describe("isValidSolanaAddress", () => {
  it("returns true for a valid base58 address", () => {
    expect(isValidSolanaAddress(VALID_ADDR)).toBe(true);
  });

  it("returns false for an empty string", () => {
    expect(isValidSolanaAddress("")).toBe(false);
  });

  it("returns false for a string that is too short", () => {
    expect(isValidSolanaAddress("abc123")).toBe(false);
  });

  it("returns false for a string containing invalid base58 chars", () => {
    expect(isValidSolanaAddress("0OIl" + "A".repeat(28))).toBe(false);
  });
});

// ── parsePaymentAmount ────────────────────────────────────────────────────────

describe("parsePaymentAmount: SOL variants", () => {
  it("parses whole SOL amount", () => {
    const r = parsePaymentAmount("1 SOL");
    expect(r).not.toBeNull();
    expect(r!.currency).toBe("SOL");
    expect(r!.amount).toBe(1);
    expect(r!.units).toBe(1_000_000_000n); // 1 SOL = 1e9 lamports
  });

  it("parses fractional SOL", () => {
    const r = parsePaymentAmount("0.05 SOL");
    expect(r).not.toBeNull();
    expect(r!.amount).toBe(0.05);
    expect(r!.units).toBe(50_000_000n);
  });

  it("parses SOL with 9 decimal places", () => {
    const r = parsePaymentAmount("0.000000001 SOL");
    expect(r).not.toBeNull();
    expect(r!.units).toBe(1n);
  });

  it("returns null for SOL with more than 9 decimals", () => {
    expect(parsePaymentAmount("0.0000000001 SOL")).toBeNull();
  });

  it("returns null for zero SOL", () => {
    expect(parsePaymentAmount("0 SOL")).toBeNull();
  });

  it("is case-insensitive for SOL", () => {
    const r = parsePaymentAmount("1 sol");
    expect(r?.currency).toBe("SOL");
  });
});

describe("parsePaymentAmount: USDC variants", () => {
  it("parses whole USDC amount", () => {
    const r = parsePaymentAmount("5 USDC");
    expect(r).not.toBeNull();
    expect(r!.currency).toBe("USDC");
    expect(r!.amount).toBe(5);
    expect(r!.units).toBe(5_000_000n); // 5 USDC = 5e6 micro-USDC
  });

  it("parses fractional USDC (2 decimals)", () => {
    const r = parsePaymentAmount("0.10 USDC");
    expect(r).not.toBeNull();
    expect(r!.units).toBe(100_000n);
  });

  it("parses USDC with 6 decimal places", () => {
    const r = parsePaymentAmount("0.000001 USDC");
    expect(r).not.toBeNull();
    expect(r!.units).toBe(1n);
  });

  it("returns null for USDC with more than 6 decimals", () => {
    expect(parsePaymentAmount("0.0000001 USDC")).toBeNull();
  });

  it("returns null for zero USDC", () => {
    expect(parsePaymentAmount("0 USDC")).toBeNull();
  });

  it("is case-insensitive for USDC", () => {
    const r = parsePaymentAmount("1 usdc");
    expect(r?.currency).toBe("USDC");
  });
});

describe("parsePaymentAmount: invalid inputs", () => {
  it("returns null for empty string", () => {
    expect(parsePaymentAmount("")).toBeNull();
  });

  it("returns null for unrecognised currency", () => {
    expect(parsePaymentAmount("1 BTC")).toBeNull();
  });

  it("returns null for text without a number", () => {
    expect(parsePaymentAmount("abc USDC")).toBeNull();
  });

  it("returns null for negative amount", () => {
    expect(parsePaymentAmount("-1 SOL")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parsePaymentAmount("   ")).toBeNull();
  });
});

// ── parseUsdcAmount ───────────────────────────────────────────────────────────

describe("parseUsdcAmount: valid inputs", () => {
  it("parses a positive number", () => {
    const r = parseUsdcAmount(5);
    expect(r).not.toBeNull();
    expect(r!.amount).toBe(5);
    expect(r!.units).toBe(5_000_000n);
  });

  it("parses a string representation", () => {
    const r = parseUsdcAmount("0.50");
    expect(r).not.toBeNull();
    expect(r!.units).toBe(500_000n);
  });

  it("parses 6 decimal places", () => {
    const r = parseUsdcAmount("0.000001");
    expect(r).not.toBeNull();
    expect(r!.units).toBe(1n);
  });
});

describe("parseUsdcAmount: invalid inputs", () => {
  it("returns null for zero", () => {
    expect(parseUsdcAmount(0)).toBeNull();
  });

  it("returns null for negative number", () => {
    expect(parseUsdcAmount(-1)).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(parseUsdcAmount(Infinity)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(parseUsdcAmount(NaN)).toBeNull();
  });

  it("returns null for more than 6 decimal places", () => {
    expect(parseUsdcAmount("0.0000001")).toBeNull();
  });

  it("returns null for non-numeric string", () => {
    expect(parseUsdcAmount("abc")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseUsdcAmount(null)).toBeNull();
  });

  it("returns null for object input", () => {
    expect(parseUsdcAmount({})).toBeNull();
  });
});

// ── formatSol / solToLamports / lamportsToSol ─────────────────────────────────

describe("formatSol", () => {
  it("formats to 4 decimal places", () => {
    expect(formatSol(1)).toBe("1.0000 SOL");
    expect(formatSol(0.05)).toBe("0.0500 SOL");
  });
});

describe("solToLamports / lamportsToSol", () => {
  it("converts 1 SOL to 1e9 lamports", () => {
    expect(solToLamports(1)).toBe(1_000_000_000);
  });

  it("converts 1e9 lamports back to 1 SOL", () => {
    expect(lamportsToSol(1_000_000_000)).toBe(1);
  });

  it("rounds lamports for fractional SOL", () => {
    // 0.05 SOL = 50_000_000 lamports exactly
    expect(solToLamports(0.05)).toBe(50_000_000);
  });
});

// ── verifyIncomingPayment (mock verifier) ─────────────────────────────────────
// Uses AXON_PAYMENT_VERIFIER=mock so no Solana RPC is required.
// Mock signature format: mockpay:CURRENCY:UNITS:SIGNER:RECEIVER:v1
// (6 colon-separated parts, receiver must match PAYMENT_RECEIVER_WALLET_ADDRESS)

const SIGNER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function mockSig(currency: string, units: bigint, signer: string, receiver: string): string {
  return `mockpay:${currency}:${units}:${signer}:${receiver}:v1`;
}

describe("verifyIncomingPayment: mock verifier — SOL", () => {
  beforeEach(() => {
    process.env.AXON_PAYMENT_VERIFIER = "mock";
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = VALID_ADDR;
  });
  afterEach(() => {
    delete process.env.AXON_PAYMENT_VERIFIER;
    delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
  });

  it("verifies a valid SOL mock payment (exact amount)", async () => {
    const expected = parsePaymentAmount("0.05 SOL")!;
    const sig = mockSig("SOL", expected.units, SIGNER, VALID_ADDR);
    expect(await verifyIncomingPayment(sig, expected, SIGNER)).toBe(true);
  });

  it("accepts payment above the required amount", async () => {
    const expected = parsePaymentAmount("0.01 SOL")!;
    const sig = mockSig("SOL", 50_000_000n, SIGNER, VALID_ADDR); // 0.05 SOL > 0.01
    expect(await verifyIncomingPayment(sig, expected, SIGNER)).toBe(true);
  });

  it("rejects when units are below required", async () => {
    const expected = parsePaymentAmount("1 SOL")!;
    const sig = mockSig("SOL", 1n, SIGNER, VALID_ADDR);
    expect(await verifyIncomingPayment(sig, expected, SIGNER)).toBe(false);
  });

  it("rejects when signer does not match expectedSigner", async () => {
    const expected = parsePaymentAmount("0.05 SOL")!;
    const sig = mockSig("SOL", expected.units, "wrongSigner", VALID_ADDR);
    expect(await verifyIncomingPayment(sig, expected, SIGNER)).toBe(false);
  });

  it("passes when no expectedSigner given (any signer accepted)", async () => {
    const expected = parsePaymentAmount("0.05 SOL")!;
    const sig = mockSig("SOL", expected.units, "anySigner", VALID_ADDR);
    expect(await verifyIncomingPayment(sig, expected)).toBe(true);
  });
});

describe("verifyIncomingPayment: mock verifier — USDC", () => {
  beforeEach(() => {
    process.env.AXON_PAYMENT_VERIFIER = "mock";
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = VALID_ADDR;
  });
  afterEach(() => {
    delete process.env.AXON_PAYMENT_VERIFIER;
    delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
  });

  it("verifies a valid USDC mock payment", async () => {
    const expected = parsePaymentAmount("0.10 USDC")!;
    const sig = mockSig("USDC", expected.units, SIGNER, VALID_ADDR);
    expect(await verifyIncomingPayment(sig, expected, SIGNER)).toBe(true);
  });

  it("rejects when currency does not match", async () => {
    const expected = parsePaymentAmount("0.10 USDC")!;
    const sig = mockSig("SOL", expected.units, SIGNER, VALID_ADDR);
    expect(await verifyIncomingPayment(sig, expected, SIGNER)).toBe(false);
  });

  it("rejects when receiver wallet does not match PAYMENT_RECEIVER_WALLET_ADDRESS", async () => {
    const expected = parsePaymentAmount("0.10 USDC")!;
    const sig = mockSig("USDC", expected.units, SIGNER, "wrongReceiver");
    expect(await verifyIncomingPayment(sig, expected, SIGNER)).toBe(false);
  });
});

describe("verifyIncomingPayment: mock verifier — malformed signatures", () => {
  beforeEach(() => {
    process.env.AXON_PAYMENT_VERIFIER = "mock";
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = VALID_ADDR;
  });
  afterEach(() => {
    delete process.env.AXON_PAYMENT_VERIFIER;
    delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
  });

  it("rejects a signature that is not the mockpay format", async () => {
    const expected = parsePaymentAmount("0.05 SOL")!;
    expect(await verifyIncomingPayment("notamocksig", expected)).toBe(false);
  });

  it("rejects a signature with the wrong prefix", async () => {
    const expected = parsePaymentAmount("0.05 SOL")!;
    expect(await verifyIncomingPayment("fakepay:SOL:50000000:s:r:v1", expected)).toBe(false);
  });

  it("rejects a signature with non-numeric units (BigInt parse fails)", async () => {
    const expected = parsePaymentAmount("0.05 SOL")!;
    const sig = `mockpay:SOL:not-a-number:${SIGNER}:${VALID_ADDR}:v1`;
    expect(await verifyIncomingPayment(sig, expected)).toBe(false);
  });
});

// NOTE: "throws when PAYMENT_RECEIVER_WALLET_ADDRESS is not set" is untestable here.
// PAYMENT_RECEIVER_WALLET_ADDRESS is a module-level constant captured at import time
// from setup.ts (which always sets NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS).
// Deleting the env var after module load has no effect on the already-captured constant.
