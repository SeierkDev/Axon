// What the burn page shows when a chain read fails.
//
// This is written from a real incident. One of the seven pot reads, preview(), started erroring on
// the server while the chain itself answered it fine from anywhere else. The reads were issued as a
// single Promise.all, so that one failure discarded the other six, and the burn page told every
// visitor "The pot is not live yet" above four zeros. At that moment the pot had done 141 burns and
// destroyed ninety-seven million tokens, all of it visible on chain.
//
// The distinction the tests below hold: losing a read costs you that figure and nothing else, and a
// read that failed never becomes a claim that the burn does not exist.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const POT = "0x419fcbc1c4a7f85bb517f3c12d13068db0d49cb9";

/** A node where the named calls throw and everything else answers. */
function nodeWhereTheseFail(failing: string[]) {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (failing.includes(functionName)) throw new Error("An unknown RPC error occurred");
      switch (functionName) {
        case "preview": return [1_000_000_000_000_000n, 1_790_000_000n, false];
        case "lastBurnAt": return 1_789_999_000n;
        case "burnCount": return 141n;
        case "totalEthBurned": return 2_032_502_914_209_211_703n;
        case "totalTokensBurned": return 96_917_945_618_905_685_425_906_850n;
        case "token": return "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
        default: throw new Error(`unexpected call ${functionName}`);
      }
    }),
    getBalance: vi.fn(async () => (failing.includes("getBalance") ? Promise.reject(new Error("rpc")) : 0n)),
  };
}

async function loadWith(failing: string[]) {
  vi.resetModules();
  process.env.AXON_BURN_POT_ADDRESS = POT;
  const node = nodeWhereTheseFail(failing);
  vi.doMock("@/lib/evm", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@/lib/evm");
    return { ...actual, publicClient: () => node };
  });
  const mod = await import("@/lib/burnLive");
  return mod.getBurnLive();
}

describe("a burn pot read that partly fails", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); vi.resetModules(); });
  beforeEach(() => { vi.restoreAllMocks(); });

  it("keeps every figure it did manage to read", async () => {
    // The incident exactly: preview() fails, everything else is fine.
    const live = await loadWith(["preview"]);

    expect(live.live).toBe(true);
    expect(live.launched).toBe(true);
    expect(live.burnCount).toBe(141);
    expect(live.totalEthBurned).toBeCloseTo(2.0325, 4);
    expect(Math.round(live.totalTokensBurned)).toBe(96_917_946);
    // The countdown is the only casualty, which is what "degraded" should mean.
    expect(live.nextBurnEth).toBe(0);
  });

  it("still knows the pot launched when the token read is the one that failed", async () => {
    // A pot that has burned 141 times is plainly launched, whatever token() did or did not answer.
    const live = await loadWith(["token"]);

    expect(live.launched).toBe(true);
    expect(live.burnCount).toBe(141);
    expect(live.tokenAddress).toBeNull();
  });

  it("reports nothing only when every read fails, and keeps the pot address", async () => {
    const live = await loadWith([
      "preview", "lastBurnAt", "burnCount", "totalEthBurned", "totalTokensBurned", "token", "getBalance",
    ]);

    expect(live.live).toBe(false);
    expect(live.burnCount).toBe(0);
    // The address is what lets the page say "cannot reach the chain" rather than "no pot exists".
    expect(live.potAddress).toBe(POT);
  });

  it("is unchanged when nothing fails", async () => {
    const live = await loadWith([]);

    expect(live.live).toBe(true);
    expect(live.launched).toBe(true);
    expect(live.burnCount).toBe(141);
    expect(live.nextBurnEth).toBeCloseTo(0.001, 6);
    expect(live.tokenAddress).toBe("0xb5e40b5f16996e9d76ec2b16e7a4ead3c06a9fa2");
  });
});
