// The watchdog. It has to stay quiet when the burn is merely waiting, and speak up when it has
// actually stopped, because a monitor that cries wolf gets muted and then it is worse than none.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const reads = vi.fn();
const balance = vi.fn();
const loopState = vi.fn();

vi.mock("@/lib/evm", () => ({
  publicClient: () => ({ readContract: reads, getBalance: balance }),
  walletClientFor: () => ({ account: { address: "0xbot" }, client: {} }),
}));
vi.mock("@/lib/burnLoop", () => ({ burnLoopState: loopState }));

const KEY = "0x" + "11".repeat(32);
const POT = "0x" + "aa".repeat(20);
const now = () => Math.floor(Date.now() / 1000);

/** preview() -> [amount, nextAt, ready]; then lastBurnAt, burnCount */
function chain(opts: { amount: bigint; nextAt: number; ready: boolean; lastBurnAt: number; count: number }) {
  reads.mockImplementation(({ functionName }: { functionName: string }) => {
    if (functionName === "preview") return Promise.resolve([opts.amount, BigInt(opts.nextAt), opts.ready]);
    if (functionName === "lastBurnAt") return Promise.resolve(BigInt(opts.lastBurnAt));
    if (functionName === "burnCount") return Promise.resolve(BigInt(opts.count));
    return Promise.resolve(0n);
  });
}
async function health() {
  const { burnHealth } = await import("@/lib/burnHealth");
  return burnHealth();
}

beforeEach(() => {
  vi.resetModules();
  reads.mockReset(); balance.mockReset(); loopState.mockReset();
  process.env.BOT_PRIVATE_KEY = KEY;
  process.env.AXON_BURN_POT_ADDRESS = POT;
  loopState.mockReturnValue({ started: true, lastCheckAt: now(), lastError: null, checkMs: 5000, sweepMs: 300000 });
  balance.mockResolvedValue(13_600_000_000_000_000n); // 0.0136 ETH, ~1100 burns
});
afterEach(() => {
  delete process.env.BOT_PRIVATE_KEY;
  delete process.env.AXON_BURN_POT_ADDRESS;
});

describe("the burn watchdog", () => {
  it("is quiet when everything is running", async () => {
    chain({ amount: 30000000000000000n, nextAt: now() + 900, ready: false, lastBurnAt: now() - 900, count: 8 });
    const h = await health();
    expect(h.ok).toBe(true);
    expect(h.problems).toEqual([]);
  });

  it("stays quiet when a burn is simply waiting for the next interval", async () => {
    chain({ amount: 30000000000000000n, nextAt: now() + 1500, ready: false, lastBurnAt: now() - 300, count: 8 });
    expect((await health()).ok).toBe(true);
  });

  it("stays quiet when the pot is empty, which is the pot waiting rather than a fault", async () => {
    chain({ amount: 0n, nextAt: now() - 3600, ready: true, lastBurnAt: now() - 7200, count: 8 });
    const h = await health();
    expect(h.problems.join(" ")).not.toContain("due and fundable");
  });

  it("speaks up when a burn is due, fundable, and still has not gone", async () => {
    chain({ amount: 30000000000000000n, nextAt: now() - 40 * 60, ready: true, lastBurnAt: now() - 90 * 60, count: 8 });
    const h = await health();
    expect(h.ok).toBe(false);
    expect(h.problems.join(" ")).toContain("due and fundable");
  });

  it("speaks up before the gas actually runs out", async () => {
    chain({ amount: 30000000000000000n, nextAt: now() + 900, ready: false, lastBurnAt: now() - 900, count: 8 });
    balance.mockResolvedValue(1_000_000_000_000_000n); // 0.001 ETH, ~83 burns
    const h = await health();
    expect(h.ok).toBe(false);
    expect(h.problems.join(" ")).toContain("top it up");
  });

  it("speaks up when the loop has gone silent", async () => {
    chain({ amount: 30000000000000000n, nextAt: now() + 900, ready: false, lastBurnAt: now() - 900, count: 8 });
    loopState.mockReturnValue({ started: true, lastCheckAt: now() - 600, lastError: null, checkMs: 5000, sweepMs: 300000 });
    const h = await health();
    expect(h.ok).toBe(false);
    expect(h.problems.join(" ")).toContain("has not checked");
  });

  it("says nothing is wrong before the pot exists", async () => {
    delete process.env.AXON_BURN_POT_ADDRESS;
    const h = await health();
    expect(h.configured).toBe(false);
    expect(h.ok).toBe(true);
  });
});
