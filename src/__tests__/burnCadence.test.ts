// Which constraint is actually holding the next burn back.
//
// The point of this module is that the burn page stops asserting a schedule and starts reporting
// one. So the tests are about the decision it makes, and about it refusing to make one when it
// does not have the evidence — a confident wrong number on the burn page is worse than no number.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const burnPageMock = vi.fn();
const getBlockNumberMock = vi.fn();
const getBlockMock = vi.fn();

vi.mock("@/lib/burnHistory", () => ({ burnPage: (...a: unknown[]) => burnPageMock(...a) }));
vi.mock("@/lib/evm", () => ({
  publicClient: () => ({
    getBlockNumber: () => getBlockNumberMock(),
    getBlock: (a: unknown) => getBlockMock(a),
  }),
}));

const COOLDOWN = 30 * 60;
const SECONDS_PER_BLOCK = 0.1;

/** Burns `gapSeconds` apart, newest first, the way burnPage returns them. */
const burnsEvery = (gapSeconds: number, count = 9) => {
  const blocksPerGap = Math.round(gapSeconds / SECONDS_PER_BLOCK);
  return {
    burns: Array.from({ length: count }, (_, i) => ({
      n: 100 - i,
      blockNumber: 1_000_000 - i * blocksPerGap,
      ethIn: 0.002,
      tokensOut: 1000,
      txHash: `0x${i}`,
      caller: "0xbot",
    })),
  };
};

const load = async () => {
  vi.resetModules();
  return import("@/lib/burnCadence");
};

describe("measuring the burn cadence", () => {
  beforeEach(() => {
    getBlockNumberMock.mockResolvedValue(1_000_000n);
    // 20 000 blocks apart, 0.1s each.
    getBlockMock.mockImplementation(({ blockNumber }: { blockNumber: bigint }) =>
      Promise.resolve({ timestamp: BigInt(Math.round(Number(blockNumber) * SECONDS_PER_BLOCK)) }),
    );
  });
  afterEach(() => vi.clearAllMocks());

  it("calls it cooldown-bound when burns land near the interval", async () => {
    burnPageMock.mockReturnValue(burnsEvery(29 * 60));
    const { getBurnCadence } = await load();

    const c = await getBurnCadence(1_000, COOLDOWN);
    // Fees arrive faster than the pot may spend them, so the thirty minutes is the real wait and
    // the contract's own countdown is the honest thing to show.
    expect(c.boundBy).toBe("cooldown");
    expect(c.medianGapSeconds).toBeCloseTo(29 * 60, -1);
    expect(c.nextDeliveryEstimate).toBeNull();
  });

  it("calls it delivery-bound when burns are an hour apart", async () => {
    burnPageMock.mockReturnValue(burnsEvery(62 * 60));
    const { getBurnCadence } = await load();

    const c = await getBurnCadence(1_000, COOLDOWN);
    // This is the case that made a healthy burn look stopped: the cooldown expires long before the
    // money lands, so counting down to it tells you nothing.
    expect(c.boundBy).toBe("delivery");
    expect(c.nextDeliveryEstimate).toBe(1_000 + c.medianGapSeconds!);
  });

  it("does not flip to delivery-bound on a slightly slow but healthy cadence", async () => {
    // 35 minutes is the pot burning as fast as it is allowed, plus polling and block time. Calling
    // that "waiting on fees" would rewrite the page over ordinary jitter.
    burnPageMock.mockReturnValue(burnsEvery(35 * 60));
    const { getBurnCadence } = await load();

    expect((await getBurnCadence(1_000, COOLDOWN)).boundBy).toBe("cooldown");
  });

  it("follows the change when deliveries slow down", async () => {
    burnPageMock.mockReturnValue(burnsEvery(29 * 60));
    const { getBurnCadence } = await load();
    expect((await getBurnCadence(1_000, COOLDOWN)).boundBy).toBe("cooldown");

    // Same code, no deploy, no edit: the upstream changed and the reading follows it.
    burnPageMock.mockReturnValue(burnsEvery(62 * 60));
    expect((await getBurnCadence(1_000, COOLDOWN)).boundBy).toBe("delivery");
  });

  it("follows it back when they speed up again", async () => {
    burnPageMock.mockReturnValue(burnsEvery(62 * 60));
    const { getBurnCadence } = await load();
    expect((await getBurnCadence(1_000, COOLDOWN)).boundBy).toBe("delivery");

    burnPageMock.mockReturnValue(burnsEvery(29 * 60));
    const back = await getBurnCadence(1_000, COOLDOWN);
    expect(back.boundBy).toBe("cooldown");
    expect(back.nextDeliveryEstimate).toBeNull();
  });

  it("ignores a single outlier gap", async () => {
    // One four-hour stall in an otherwise half-hourly week should not rewrite the page. The median
    // is chosen over the mean for exactly this.
    const rows = burnsEvery(29 * 60);
    rows.burns[3]!.blockNumber -= Math.round((4 * 3600) / SECONDS_PER_BLOCK);
    for (let i = 4; i < rows.burns.length; i++) {
      rows.burns[i]!.blockNumber -= Math.round((4 * 3600) / SECONDS_PER_BLOCK);
    }
    burnPageMock.mockReturnValue(rows);
    const { getBurnCadence } = await load();

    expect((await getBurnCadence(1_000, COOLDOWN)).boundBy).toBe("cooldown");
  });

  it("says nothing when there are too few burns to judge", async () => {
    burnPageMock.mockReturnValue(burnsEvery(30 * 60, 3));
    const { getBurnCadence } = await load();

    const c = await getBurnCadence(1_000, COOLDOWN);
    expect(c.boundBy).toBe("unknown");
    expect(c.medianGapSeconds).toBeNull();
  });

  it("says nothing when block time cannot be read", async () => {
    burnPageMock.mockReturnValue(burnsEvery(62 * 60));
    getBlockMock.mockRejectedValue(new Error("rpc down"));
    const { getBurnCadence } = await load();

    // Without block time the gaps are in blocks, not seconds, and guessing the conversion is how
    // you end up publishing a fabricated schedule.
    expect((await getBurnCadence(1_000, COOLDOWN)).boundBy).toBe("unknown");
  });

  it("rejects an absurd block time rather than trusting it", async () => {
    burnPageMock.mockReturnValue(burnsEvery(62 * 60));
    getBlockMock.mockImplementation(({ blockNumber }: { blockNumber: bigint }) =>
      Promise.resolve({ timestamp: BigInt(Number(blockNumber) * 600) }), // 600s per block
    );
    const { getBurnCadence } = await load();

    expect((await getBurnCadence(1_000, COOLDOWN)).boundBy).toBe("unknown");
  });

  it("survives the history being unreadable", async () => {
    burnPageMock.mockImplementation(() => { throw new Error("db gone"); });
    const { getBurnCadence } = await load();

    // The burn page must render whatever happens here. This describes the burn, it does not run it.
    const c = await getBurnCadence(1_000, COOLDOWN);
    expect(c).toEqual({ medianGapSeconds: null, sample: 0, boundBy: "unknown", nextDeliveryEstimate: null });
  });

  it("gives no delivery estimate without a last burn time", async () => {
    burnPageMock.mockReturnValue(burnsEvery(62 * 60));
    const { getBurnCadence } = await load();

    expect((await getBurnCadence(0, COOLDOWN)).nextDeliveryEstimate).toBeNull();
  });
});
