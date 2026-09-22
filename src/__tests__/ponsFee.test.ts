import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ponsLaunchFeeWei, clearPonsFeeCache } from "@/lib/ponsFee";

/**
 * The launch fee used to be a string in the browser bundle. It was correct, and that is the problem: it was
 * correct on the day it was typed, on a contract nobody here controls. BurnPot reverts when msg.value is
 * under the real fee, so the day Pons raises it every launch fails in the wallet.
 */

const reply = (result: unknown) =>
  vi.fn().mockResolvedValue({ json: async () => ({ jsonrpc: "2.0", id: 1, result }) });

describe("the Pons launch fee", () => {
  const realFetch = global.fetch;

  beforeEach(() => clearPonsFeeCache());
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("is whatever Pons says it is", async () => {
    global.fetch = reply(`0x${(1_500_000_000_000_000n).toString(16).padStart(64, "0")}`) as never;
    expect(await ponsLaunchFeeWei()).toBe(1_500_000_000_000_000n);
  });

  it("asks once and then remembers", async () => {
    const f = reply(`0x${(5e14).toString(16)}`);
    global.fetch = f as never;

    await ponsLaunchFeeWei();
    await ponsLaunchFeeWei();
    await ponsLaunchFeeWei();

    expect(f).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last known fee when the RPC is down", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as never;
    // A page that cannot reach the RPC should still render. The wallet rejects a short launch anyway,
    // and that is a clearer failure than an eligibility check that 500s.
    expect(await ponsLaunchFeeWei()).toBe(500_000_000_000_000n);
  });

  it("treats a zero or empty answer as malformed rather than as a free launch", async () => {
    global.fetch = reply("0x") as never;
    expect(await ponsLaunchFeeWei()).toBe(500_000_000_000_000n);

    clearPonsFeeCache();
    global.fetch = reply(`0x${"0".repeat(64)}`) as never;
    expect(await ponsLaunchFeeWei()).toBe(500_000_000_000_000n);
  });

  it("does not cache a fallback, so a recovered RPC is picked up", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("down")) as never;
    expect(await ponsLaunchFeeWei()).toBe(500_000_000_000_000n);

    global.fetch = reply(`0x${(2_000_000_000_000_000n).toString(16).padStart(64, "0")}`) as never;
    expect(await ponsLaunchFeeWei()).toBe(2_000_000_000_000_000n);
  });
});
