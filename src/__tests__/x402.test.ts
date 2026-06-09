// Tests for src/lib/x402.ts — pure encode/decode/build functions only.
// verifyX402Payment is not tested here (requires on-chain Solana calls).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildX402Requirements,
  encodeRequirements,
  decodeRequirements,
  buildPaymentHeader,
  decodePaymentHeader,
  X402_VERSION,
  X402_SCHEME,
} from "@/lib/x402";

const TEST_RESOURCE = "https://api.example.com/task";
const TEST_PRICE = "0.10 USDC";
const TEST_DESCRIPTION = "Access to research task";

// PAYMENT_RECEIVER_WALLET_ADDRESS must be set for buildX402Requirements to work
beforeEach(() => {
  process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = "11111111111111111111111111111111";
  process.env.SOLANA_NETWORK = "devnet";
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
  delete process.env.SOLANA_NETWORK;
});

// ── buildX402Requirements ─────────────────────────────────────────────────────

describe("buildX402Requirements", () => {
  it("builds a valid requirements object for a USDC price", () => {
    const req = buildX402Requirements({
      resource: TEST_RESOURCE,
      price: TEST_PRICE,
      description: TEST_DESCRIPTION,
    });
    expect(req).not.toBeNull();
    expect(req!.version).toBe(X402_VERSION);
    expect(req!.accepts).toHaveLength(1);
    const opt = req!.accepts[0];
    expect(opt.scheme).toBe(X402_SCHEME);
    expect(opt.resource).toBe(TEST_RESOURCE);
    expect(opt.description).toBe(TEST_DESCRIPTION);
    expect(opt.payToAddress).toBe("11111111111111111111111111111111");
    expect(opt.asset).toBe("USDC");
    expect(opt.maxAmountRequired).toBe("100000"); // 0.10 USDC = 100_000 micro-USDC
    expect(opt.requiredDeadlineSeconds).toBe(300);
  });

  it("returns null for a SOL-priced agent (only USDC is supported)", () => {
    const req = buildX402Requirements({ resource: TEST_RESOURCE, price: "0.05 SOL", description: "x" });
    expect(req).toBeNull();
  });

  it("returns null for an unrecognised price format", () => {
    const req = buildX402Requirements({ resource: TEST_RESOURCE, price: "not-a-price", description: "x" });
    expect(req).toBeNull();
  });

  it("uses solana-mainnet when SOLANA_NETWORK is not 'devnet'", () => {
    delete process.env.SOLANA_NETWORK;
    const req = buildX402Requirements({ resource: TEST_RESOURCE, price: TEST_PRICE, description: "x" });
    expect(req!.accepts[0].network).toBe("solana-mainnet");
  });

  it("uses solana-devnet when SOLANA_NETWORK=devnet", () => {
    const req = buildX402Requirements({ resource: TEST_RESOURCE, price: TEST_PRICE, description: "x" });
    expect(req!.accepts[0].network).toBe("solana-devnet");
  });
});

// ── encodeRequirements / decodeRequirements round-trip ────────────────────────

describe("encodeRequirements / decodeRequirements", () => {
  it("round-trips a requirements object through base64", () => {
    const req = buildX402Requirements({ resource: TEST_RESOURCE, price: TEST_PRICE, description: TEST_DESCRIPTION })!;
    const encoded = encodeRequirements(req);
    expect(typeof encoded).toBe("string");
    const decoded = decodeRequirements(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.version).toBe(X402_VERSION);
    expect(decoded!.accepts[0].resource).toBe(TEST_RESOURCE);
  });

  it("decodeRequirements returns null for an empty string", () => {
    expect(decodeRequirements("")).toBeNull();
  });

  it("decodeRequirements returns null for non-base64 input", () => {
    expect(decodeRequirements("not-base64!!!")).toBeNull();
  });

  it("decodeRequirements returns null when version is wrong", () => {
    const bad = Buffer.from(JSON.stringify({ version: "x402/99", accepts: [{}] })).toString("base64");
    expect(decodeRequirements(bad)).toBeNull();
  });

  it("decodeRequirements returns null when accepts is empty", () => {
    const bad = Buffer.from(JSON.stringify({ version: X402_VERSION, accepts: [] })).toString("base64");
    expect(decodeRequirements(bad)).toBeNull();
  });

  it("decodeRequirements returns null when accepts is missing", () => {
    const bad = Buffer.from(JSON.stringify({ version: X402_VERSION })).toString("base64");
    expect(decodeRequirements(bad)).toBeNull();
  });
});

// ── buildPaymentHeader / decodePaymentHeader ──────────────────────────────────

describe("buildPaymentHeader / decodePaymentHeader", () => {
  const SIG = "5LzS5nJqKP4K5y5B5n6jF1a2b3c4d5e6f7g8h9i0jklmnopqrstuvwxyz1234";
  const FROM = "11111111111111111111111111111111";
  const NETWORK = "solana-devnet";

  it("round-trips a payment header through base64", () => {
    const raw = buildPaymentHeader(SIG, FROM, NETWORK);
    expect(typeof raw).toBe("string");
    const parsed = decodePaymentHeader(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.scheme).toBe(X402_SCHEME);
    expect(parsed!.network).toBe(NETWORK);
    expect(parsed!.payload.signature).toBe(SIG);
    expect(parsed!.payload.from).toBe(FROM);
  });

  it("decodePaymentHeader returns null for an empty string", () => {
    expect(decodePaymentHeader("")).toBeNull();
  });

  it("decodePaymentHeader returns null for non-base64 garbage", () => {
    expect(decodePaymentHeader("not-base64!!!")).toBeNull();
  });

  it("decodePaymentHeader returns null when scheme is wrong", () => {
    const bad = Buffer.from(JSON.stringify({
      scheme: "wrong",
      network: NETWORK,
      payload: { signature: SIG, from: FROM },
    })).toString("base64");
    expect(decodePaymentHeader(bad)).toBeNull();
  });

  it("decodePaymentHeader returns null when signature is missing", () => {
    const bad = Buffer.from(JSON.stringify({
      scheme: X402_SCHEME,
      network: NETWORK,
      payload: { signature: "", from: FROM },
    })).toString("base64");
    expect(decodePaymentHeader(bad)).toBeNull();
  });

  it("decodePaymentHeader returns null when from is missing", () => {
    const bad = Buffer.from(JSON.stringify({
      scheme: X402_SCHEME,
      network: NETWORK,
      payload: { signature: SIG, from: "" },
    })).toString("base64");
    expect(decodePaymentHeader(bad)).toBeNull();
  });

  it("decodePaymentHeader returns null when network is missing", () => {
    const bad = Buffer.from(JSON.stringify({
      scheme: X402_SCHEME,
      payload: { signature: SIG, from: FROM },
    })).toString("base64");
    expect(decodePaymentHeader(bad)).toBeNull();
  });
});
