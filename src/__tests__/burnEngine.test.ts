// The engine holds a funded key and calls contracts with it, so what it refuses to do matters
// more than what it does.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const reads = vi.fn();
const writes = vi.fn();
const waits = vi.fn();

vi.mock("@/lib/evm", () => ({
  publicClient: () => ({ readContract: reads, waitForTransactionReceipt: waits }),
  walletClientFor: (key: string) => {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key.trim())) throw new Error("bad key");
    return { account: { address: "0xbot" }, client: { writeContract: writes } };
  },
}));

const KEY = "0x" + "11".repeat(32);
const POT = "0x" + "aa".repeat(20);
const SPLIT = "0x" + "bb".repeat(20);

async function run() {
  const { runBurnEngine } = await import("@/lib/burnEngine");
  return runBurnEngine();
}

beforeEach(() => {
  vi.resetModules();
  reads.mockReset(); writes.mockReset(); waits.mockReset();
  waits.mockResolvedValue({ status: "success" });
  process.env.BOT_PRIVATE_KEY = KEY;
  process.env.AXON_BURN_POT_ADDRESS = POT;
  process.env.AXON_SPLITTER_ADDRESS = SPLIT;
});
afterEach(() => {
  delete process.env.BOT_PRIVATE_KEY;
  delete process.env.AXON_BURN_POT_ADDRESS;
  delete process.env.AXON_SPLITTER_ADDRESS;
});

describe("the burn engine does nothing it should not", () => {
  it("spends no gas at all before the pot exists", async () => {
    delete process.env.AXON_BURN_POT_ADDRESS;
    const r = await run();
    expect(r.configured).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  it("spends no gas without a key", async () => {
    delete process.env.BOT_PRIVATE_KEY;
    const r = await run();
    expect(r.configured).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  it("does not call burn when the pot says it is not due", async () => {
    reads.mockResolvedValue([1000000000000000n, 1800n, false]); // amount, nextAt, ready=false
    writes.mockResolvedValue("0xsweep");

    const r = await run();

    // swept, but never burned
    const burnCalls = writes.mock.calls.filter(([a]) => a.functionName === "burn");
    expect(burnCalls).toHaveLength(0);
    expect(r.burned.ran).toBe(false);
    expect(r.next?.ready).toBe(false);
  });

  it("does not call burn when the pot is due but empty", async () => {
    reads.mockResolvedValue([0n, 0n, true]); // ready, but nothing in it
    writes.mockResolvedValue("0xsweep");

    await run();

    expect(writes.mock.calls.filter(([a]) => a.functionName === "burn")).toHaveLength(0);
  });

  it("burns when the pot says it is due, with a zero floor as the contract intends", async () => {
    reads.mockResolvedValue([2000000000000000n, 100n, true]);
    writes.mockResolvedValue("0xburn");

    const r = await run();

    const burn = writes.mock.calls.find(([a]) => a.functionName === "burn");
    expect(burn).toBeTruthy();
    expect(burn![0].args).toEqual([0n]);
    expect(r.burned.ran).toBe(true);
    expect(r.burned.ethIn).toBeCloseTo(0.002, 9);
  });

  it("still burns when the sweep reverts, which is its normal state between trades", async () => {
    reads.mockResolvedValue([2000000000000000n, 100n, true]);
    writes.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "sweep") throw new Error("execution reverted: nothing to sweep");
      return "0xburn";
    });

    const r = await run();

    expect(r.swept.ran).toBe(false);
    expect(r.burned.ran).toBe(true);
  });

  it("reports a refusal by name instead of raising it", async () => {
    reads.mockResolvedValue([2000000000000000n, 100n, true]);
    writes.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "burn") throw new Error("execution reverted, custom error TooSoon(1800)");
      return "0xsweep";
    });

    const r = await run();

    expect(r.ok).toBe(true);           // a burn that was not due is not a failure
    expect(r.burned.ran).toBe(false);
    expect(r.burned.error).toBe("TooSoon");
  });

  it("treats a reverted burn receipt as not burned", async () => {
    reads.mockResolvedValue([2000000000000000n, 100n, true]);
    writes.mockResolvedValue("0xburn");
    waits.mockResolvedValue({ status: "reverted" });

    const r = await run();

    expect(r.burned.ran).toBe(false);
  });
});
