// The places that ask "is this an address?" or "is this a real transaction?"
//
// All three of these were written against base58, which is the one encoding with no zero in its
// alphabet. On a chain where every address and every hash begins "0x", each of them answered no
// to every genuine value: the World refused to save a character, and a receipt for a real payment
// showed no link to the transaction that settled it. Nothing threw — they just quietly said no.

import { describe, it, expect } from "vitest";
import { isValidWallet } from "@/lib/worldAvatar";
import { isOnChainTxHash } from "@/lib/chain";
import { logger } from "@/lib/logger";

const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TX_HASH = "0x" + "ab12cd34".repeat(8); // 0x + 64 hex

describe("EVM identifiers are recognised", () => {
  it("accepts a real address as a wallet, in either case", () => {
    expect(isValidWallet(ADDRESS)).toBe(true);
    expect(isValidWallet(ADDRESS.toLowerCase())).toBe(true);
  });

  it("still refuses things that are not addresses", () => {
    expect(isValidWallet("")).toBe(false);
    expect(isValidWallet("0x1234")).toBe(false);
    expect(isValidWallet(`${ADDRESS}00`)).toBe(false);
    expect(isValidWallet("not-an-address")).toBe(false);
  });

  it("accepts a real transaction hash, and refuses a synthetic settlement id", () => {
    expect(isOnChainTxHash(TX_HASH)).toBe(true);
    expect(isOnChainTxHash(TX_HASH.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isOnChainTxHash("hist-sig-code-agent-d3")).toBe(false);
    expect(isOnChainTxHash("sig123abc")).toBe(false);
    expect(isOnChainTxHash("0x" + "ab".repeat(20))).toBe(false); // an address, not a hash
  });
});

describe("log field truncation covers an EVM address", () => {
  it("shortens an address in a log field, as it always did for the old spelling", () => {
    const calls: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { calls.push(String(args[0])); };
    try {
      logger.error("test.evm.wallet", "msg", { sender: ADDRESS });
    } finally {
      console.error = original;
    }
    const parsed = JSON.parse(calls[0]) as { sender?: string };
    expect(parsed.sender).toBeDefined();
    expect((parsed.sender ?? "").length).toBeLessThan(ADDRESS.length);
  });
});
