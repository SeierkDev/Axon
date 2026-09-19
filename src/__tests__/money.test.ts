// The money vocabulary, and the exactness it exists to guarantee.
//
// The rule under test throughout: a decimal is for reading, wei is for arithmetic. Most of these
// cases are ones a float would quietly get wrong — amounts with no exact binary representation,
// amounts finer than a double can hold, and comparisons that must not be off by even one wei.
//
// The transport this sits on is tested in circuit-breaker, chain-send and chain-verify.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parsePaymentAmount,
  parseAmount,
  toWei,
  weiToEth,
  weiToDecimalString,
  decimalToWei,
  formatEth,
  verifyIncomingPayment,
  WEI_PER_ETH,
} from "@/lib/money";

// ── parsePaymentAmount ────────────────────────────────────────────────────────

describe("parsePaymentAmount", () => {
  it("parses a whole ETH amount", () => {
    const r = parsePaymentAmount("1 ETH")!;
    expect(r.currency).toBe("ETH");
    expect(r.amount).toBe(1);
    expect(r.wei).toBe(WEI_PER_ETH);
  });

  it("parses a fractional amount exactly", () => {
    expect(parsePaymentAmount("0.05 ETH")!.wei).toBe(50_000_000_000_000_000n);
  });

  // These have no exact binary representation. Going via the digits lands on the intended wei;
  // going via the double's own value does not, and the difference is money.
  it("parses amounts a float would get wrong", () => {
    expect(parsePaymentAmount("0.1 ETH")!.wei).toBe(100_000_000_000_000_000n);
    expect(parsePaymentAmount("0.07 ETH")!.wei).toBe(70_000_000_000_000_000n);
    expect(BigInt((0.07).toFixed(18).replace(".", ""))).not.toBe(70_000_000_000_000_000n);
  });

  it("parses down to a single wei", () => {
    expect(parsePaymentAmount("0.000000000000000001 ETH")!.wei).toBe(1n);
  });

  it("is case-insensitive about the unit", () => {
    expect(parsePaymentAmount("0.5 eth")!.wei).toBe(500_000_000_000_000_000n);
  });

  it("tolerates spacing", () => {
    expect(parsePaymentAmount("  0.5ETH ")!.wei).toBe(500_000_000_000_000_000n);
  });

  it("refuses zero", () => {
    expect(parsePaymentAmount("0 ETH")).toBeNull();
  });

  it("refuses the currencies this chain does not settle in", () => {
    expect(parsePaymentAmount("1 SOL")).toBeNull();
    expect(parsePaymentAmount("5 USDC")).toBeNull();
  });

  it("refuses unparseable text", () => {
    for (const bad of ["", "   ", "ETH", "abc ETH", "-1 ETH", "1.2.3 ETH", "1e5 ETH"]) {
      expect(parsePaymentAmount(bad)).toBeNull();
    }
  });

  // Refusing is the right answer. Rounding would silently charge a different amount than the one
  // that was written down.
  it("refuses more precision than the chain has, rather than rounding it away", () => {
    expect(parsePaymentAmount("0.0000000000000000001 ETH")).toBeNull();
  });
});

// ── decimal ↔ wei ─────────────────────────────────────────────────────────────

describe("decimalToWei / weiToDecimalString", () => {
  it("round-trips exactly", () => {
    for (const v of ["1", "0.1", "0.05", "123.456789012345678", "0.000000000000000001"]) {
      expect(weiToDecimalString(decimalToWei(v)!)).toBe(v);
    }
  });

  it("renders whole amounts without a decimal point", () => {
    expect(weiToDecimalString(WEI_PER_ETH)).toBe("1");
    expect(weiToDecimalString(0n)).toBe("0");
  });

  it("never renders in exponent notation", () => {
    expect(weiToDecimalString(1n)).toBe("0.000000000000000001");
    expect(weiToDecimalString(1n)).not.toContain("e");
  });

  it("refuses a negative or malformed decimal", () => {
    for (const bad of ["-1", "abc", "", "1e18", "1.2.3"]) expect(decimalToWei(bad)).toBeNull();
  });
});

describe("toWei", () => {
  it("accepts a number, a string and a bigint", () => {
    expect(toWei(1)).toBe(WEI_PER_ETH);
    expect(toWei("1")).toBe(WEI_PER_ETH);
    expect(toWei(WEI_PER_ETH)).toBe(WEI_PER_ETH);
  });

  // String(1e-7) is "1e-7", which is not a decimal at all. Converting through text has to handle
  // that, or every small amount silently becomes null.
  it("handles small numbers that JS would render in exponent notation", () => {
    expect(toWei(0.0000001)).toBe(100_000_000_000n);
    expect(String(0.0000001)).toContain("e");
  });

  it("refuses what is not an amount", () => {
    for (const bad of [NaN, Infinity, -1, "abc", null, undefined, {}]) {
      expect(toWei(bad)).toBeNull();
    }
  });
});

describe("parseAmount", () => {
  it("parses a bare number or string", () => {
    expect(parseAmount(0.05)!.wei).toBe(50_000_000_000_000_000n);
    expect(parseAmount("0.05")!.wei).toBe(50_000_000_000_000_000n);
  });

  it("refuses zero and below", () => {
    expect(parseAmount(0)).toBeNull();
    expect(parseAmount(-1)).toBeNull();
  });
});

describe("weiToEth / formatEth", () => {
  it("reads wei back as ETH", () => {
    expect(weiToEth(50_000_000_000_000_000n)).toBe(0.05);
    expect(weiToEth(WEI_PER_ETH)).toBe(1);
  });

  it("formats with the unit and no trailing zeroes", () => {
    expect(formatEth(WEI_PER_ETH)).toBe("1 ETH");
    expect(formatEth(50_000_000_000_000_000n)).toBe("0.05 ETH");
  });
});

// ── verifyIncomingPayment (mock verifier) ─────────────────────────────────────
// mockpay:CURRENCY:WEI:SIGNER:RECEIVER:v1 — six parts, receiver must match the treasury.

const SIGNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TREASURY = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const mockSig = (currency: string, wei: bigint, signer: string, receiver: string) =>
  `mockpay:${currency}:${wei}:${signer}:${receiver}:v1`;

describe("verifyIncomingPayment: the mock lane", () => {
  beforeEach(() => {
    process.env.AXON_PAYMENT_VERIFIER = "mock";
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = TREASURY;
  });
  afterEach(() => {
    delete process.env.AXON_PAYMENT_VERIFIER;
    delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
  });

  it("accepts the exact amount", async () => {
    const expected = parsePaymentAmount("0.05 ETH")!;
    expect(await verifyIncomingPayment(mockSig("ETH", expected.wei, SIGNER, TREASURY), expected, SIGNER)).toBe(true);
  });

  it("accepts an overpayment", async () => {
    const expected = parsePaymentAmount("0.01 ETH")!;
    expect(await verifyIncomingPayment(mockSig("ETH", 50_000_000_000_000_000n, SIGNER, TREASURY), expected, SIGNER)).toBe(true);
  });

  // The case a float comparison is most likely to get wrong, and the one that costs real money.
  it("refuses an underpayment of a single wei", async () => {
    const expected = parsePaymentAmount("0.05 ETH")!;
    const sig = mockSig("ETH", expected.wei - 1n, SIGNER, TREASURY);
    expect(await verifyIncomingPayment(sig, expected, SIGNER)).toBe(false);
  });

  it("refuses the wrong payer", async () => {
    const expected = parsePaymentAmount("0.05 ETH")!;
    expect(await verifyIncomingPayment(mockSig("ETH", expected.wei, "0xdead", TREASURY), expected, SIGNER)).toBe(false);
  });

  it("accepts any payer when none is named", async () => {
    const expected = parsePaymentAmount("0.05 ETH")!;
    expect(await verifyIncomingPayment(mockSig("ETH", expected.wei, "0xdead", TREASURY), expected)).toBe(true);
  });

  it("refuses a payment to a different address", async () => {
    const expected = parsePaymentAmount("0.05 ETH")!;
    expect(await verifyIncomingPayment(mockSig("ETH", expected.wei, SIGNER, "0xdead"), expected, SIGNER)).toBe(false);
  });

  it("refuses a currency this chain does not settle in", async () => {
    const expected = parsePaymentAmount("0.05 ETH")!;
    expect(await verifyIncomingPayment(mockSig("USDC", expected.wei, SIGNER, TREASURY), expected, SIGNER)).toBe(false);
  });

  it("refuses malformed signatures without throwing", async () => {
    const expected = parsePaymentAmount("0.05 ETH")!;
    for (const bad of ["", "mockpay", "mockpay:ETH:1:a:b", "notmock:ETH:1:a:b:v1", `mockpay:ETH:notanumber:${SIGNER}:${TREASURY}:v1`]) {
      expect(await verifyIncomingPayment(bad, expected, SIGNER)).toBe(false);
    }
  });
});
