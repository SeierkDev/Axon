// Tests for src/lib/x402.ts — pure encode/decode/build functions only.
// verifyX402Payment is not tested here (requires on-chain Solana calls).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toWei } from "@/lib/money";
import { CHAIN_ID } from "@/lib/chain";
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
const TEST_PRICE = "0.0001 ETH";
const TEST_DESCRIPTION = "Access to research task";

// PAYMENT_RECEIVER_WALLET_ADDRESS must be set for buildX402Requirements to work
beforeEach(() => {
  process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
});

// ── buildX402Requirements ─────────────────────────────────────────────────────

describe("buildX402Requirements", () => {
  it("builds a valid requirements object for a price", () => {
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
    expect(opt.payToAddress).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    expect(opt.asset).toBe("ETH");
    // Quoted in wei, as a string: the amount reaches the client without passing through a float.
    expect(opt.maxAmountRequired).toBe(String(toWei(TEST_PRICE.split(" ")[0])));
    expect(opt.requiredDeadlineSeconds).toBe(300);
  });

  it("returns null for a currency this chain does not settle in", () => {
    expect(buildX402Requirements({ resource: TEST_RESOURCE, price: "0.05 SOL", description: "x" })).toBeNull();
    expect(buildX402Requirements({ resource: TEST_RESOURCE, price: "5 USDC", description: "x" })).toBeNull();
  });

  it("returns null for an unrecognised price format", () => {
    const req = buildX402Requirements({ resource: TEST_RESOURCE, price: "not-a-price", description: "x" });
    expect(req).toBeNull();
  });

  // x402 names a network with a CAIP-2 identifier; for an EVM chain that is eip155 plus its id.
  it("names the chain the way x402 expects", () => {
    const req = buildX402Requirements({ resource: TEST_RESOURCE, price: TEST_PRICE, description: "x" });
    expect(req!.accepts[0].network).toBe(`eip155:${CHAIN_ID}`);
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
  const FROM = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
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
