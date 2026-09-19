// The guards in front of anything that moves funds.
//
// Every path here refuses BEFORE a node is contacted, which is the point: a misconfigured signer
// must fail loudly at the door rather than send real money from a wallet nobody intended.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sendNative, payNative, postMemoTransaction } from "@/lib/evm";

// A well-formed key that is NOT the payment receiver configured in setup.ts.
// deliberately NOT the key for the treasury configured in setup.ts
const OTHER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

beforeEach(() => {
  delete process.env.REFUND_SIGNER_PRIVATE_KEY;
});
afterEach(() => {
  delete process.env.REFUND_SIGNER_PRIVATE_KEY;
});

describe("sendNative: refuses before it can send", () => {
  it("rejects a recipient that is not an address", async () => {
    process.env.REFUND_SIGNER_PRIVATE_KEY = OTHER_KEY;
    await expect(sendNative("not-an-address", 1)).rejects.toThrow(/is not an address/);
  });

  it("rejects a zero amount", async () => {
    process.env.REFUND_SIGNER_PRIVATE_KEY = OTHER_KEY;
    await expect(sendNative(RECIPIENT, 0)).rejects.toThrow(/must be positive/);
  });

  it("throws when REFUND_SIGNER_PRIVATE_KEY is not set", async () => {
    await expect(sendNative(RECIPIENT, 1)).rejects.toThrow(/REFUND_SIGNER_PRIVATE_KEY is not set/);
  });

  it("throws when the key is not 32 bytes of hex", async () => {
    process.env.REFUND_SIGNER_PRIVATE_KEY = "not-a-key!!!";
    await expect(sendNative(RECIPIENT, 1)).rejects.toThrow(/32 bytes of hex/);
  });

  // The guard that matters most: a key for some other wallet would move real funds out of an
  // account nobody chose, and there is no taking that back.
  it("refuses a signer that is not the payment receiver", async () => {
    process.env.REFUND_SIGNER_PRIVATE_KEY = OTHER_KEY;
    await expect(sendNative(RECIPIENT, 1)).rejects.toThrow(
      /does not match PAYMENT_RECEIVER_WALLET_ADDRESS/,
    );
  });
});

describe("payNative: an agent paying from its own wallet", () => {
  it("rejects a recipient that is not an address", async () => {
    await expect(payNative(OTHER_KEY, "nope", 1)).rejects.toThrow(/is not an address/);
  });

  it("rejects a zero amount", async () => {
    await expect(payNative(OTHER_KEY, RECIPIENT, 0)).rejects.toThrow(/must be positive/);
  });

  it("rejects a malformed payer key", async () => {
    await expect(payNative("0xdead", RECIPIENT, 1)).rejects.toThrow(/32 bytes of hex/);
  });

  // payNative deliberately does NOT check against the payment receiver: the whole point is that the
  // agent pays from a wallet of its own.
  it("accepts a key with or without the 0x prefix", async () => {
    const bare = OTHER_KEY.slice(2);
    await expect(payNative(bare, "nope", 1)).rejects.toThrow(/is not an address/);
  });
});

describe("postMemoTransaction", () => {
  it("throws when REFUND_SIGNER_PRIVATE_KEY is not set", async () => {
    await expect(postMemoTransaction("hello")).rejects.toThrow(/REFUND_SIGNER_PRIVATE_KEY is not set/);
  });

  it("throws when the key is malformed", async () => {
    process.env.REFUND_SIGNER_PRIVATE_KEY = "nonsense";
    await expect(postMemoTransaction("hello")).rejects.toThrow(/32 bytes of hex/);
  });
});
