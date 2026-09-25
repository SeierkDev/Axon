// What a wallet's $AXON balance entitles it to.
//
// Phase 1 resolves a tier and nothing consumes it yet, which makes this the right moment to pin the
// rules down. The two that matter: base is the network exactly as it is today, so nobody can lose
// anything by this existing; and an unreadable chain degrades rather than fails, because a node
// blinking must never take an entitlement away from someone who paid for it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const readContract = vi.fn();
vi.mock("@/lib/evm", () => ({ publicClient: () => ({ readContract: (a: unknown) => readContract(a) }) }));

const WALLET = "0x1111111111111111111111111111111111111111";
const DECIMALS = 18;

/** balanceOf answers `whole` tokens; decimals answers 18. */
const holding = (whole: number | bigint) =>
  readContract.mockImplementation(({ functionName }: { functionName: string }) =>
    functionName === "decimals"
      ? Promise.resolve(DECIMALS)
      : Promise.resolve(BigInt(whole) * 10n ** BigInt(DECIMALS)),
  );

const load = async () => {
  vi.resetModules();
  const mod = await import("@/lib/holderTier");
  mod._clearTierCache();
  return mod;
};

describe("the ladder", () => {
  beforeEach(() => { process.env.AXON_TOKEN_ADDRESS = "0x2222222222222222222222222222222222222222"; });
  afterEach(() => { vi.clearAllMocks(); delete process.env.AXON_TIER_THRESHOLDS; });

  it("puts a wallet holding nothing on base", async () => {
    const { tierForBalance } = await load();
    expect(tierForBalance(0).name).toBe("base");
    expect(tierForBalance(1_000).name).toBe("base");
  });

  it("starts where holding actually costs something", async () => {
    // Deliberately above the arcade's 1,000 gate: that number gates a leaderboard on a game and is
    // meant to be trivial. These gate real throughput and real spend.
    const { tierForBalance } = await load();
    expect(tierForBalance(249_999).name).toBe("base");
    expect(tierForBalance(250_000).name).toBe("holder");
  });

  it("climbs the rungs", async () => {
    const { tierForBalance } = await load();
    expect(tierForBalance(2_499_999).name).toBe("holder");
    expect(tierForBalance(2_500_000).name).toBe("builder");
    expect(tierForBalance(10_000_000).name).toBe("operator");
    expect(tierForBalance(500_000_000).name).toBe("operator");
  });

  it("takes thresholds from the environment", async () => {
    process.env.AXON_TIER_THRESHOLDS = "500,5000,50000";
    const { tierForBalance } = await load();
    expect(tierForBalance(500).name).toBe("holder");
    expect(tierForBalance(5_000).name).toBe("builder");
  });

  it("ignores a malformed setting rather than half-applying it", async () => {
    // A partly-parsed ladder would quietly move everyone's entitlements, and nothing would say so.
    process.env.AXON_TIER_THRESHOLDS = "250000,not-a-number,50000";
    const { tierForBalance } = await load();
    expect(tierForBalance(2_500_000).name).toBe("builder");
  });

  it("ignores thresholds that do not rise", async () => {
    process.env.AXON_TIER_THRESHOLDS = "5000,1000,50000";
    const { tierForBalance } = await load();
    expect(tierForBalance(250_000).name).toBe("holder");
  });
});

describe("resolving a wallet", () => {
  beforeEach(() => { process.env.AXON_TOKEN_ADDRESS = "0x2222222222222222222222222222222222222222"; });
  afterEach(() => { vi.clearAllMocks(); });

  it("reads the balance and returns the tier", async () => {
    holding(3_000_000);
    const { getTier } = await load();

    const r = await getTier(WALLET);
    expect(r.tier.name).toBe("builder");
    expect(r.balance).toBe(3_000_000);
    expect(r.stale).toBe(false);
  });

  it("scales by the token's own decimals rather than assuming them", async () => {
    // Compared at the wrong scale this either promotes everyone or nobody, and does it silently.
    readContract.mockImplementation(({ functionName }: { functionName: string }) =>
      functionName === "decimals" ? Promise.resolve(6) : Promise.resolve(2_000n * 10n ** 6n),
    );
    const { getTier } = await load();

    expect((await getTier(WALLET)).balance).toBe(2_000);
  });

  it("gives an anonymous caller the base tier without touching the chain", async () => {
    holding(10_000_000);
    const { getTier } = await load();

    const r = await getTier(null);
    expect(r.tier.name).toBe("base");
    // Most callers are anonymous: MCP clients and free-lane hires carry no wallet at all.
    expect(readContract).not.toHaveBeenCalled();
  });

  it("gives the base tier when no token is configured", async () => {
    delete process.env.AXON_TOKEN_ADDRESS;
    const { getTier } = await load();

    expect((await getTier(WALLET)).tier.name).toBe("base");
  });

  it("caches, so a busy caller does not hit the chain on every request", async () => {
    holding(250_000);
    const { getTier } = await load();

    await getTier(WALLET);
    await getTier(WALLET);
    await getTier(WALLET);
    expect(readContract).toHaveBeenCalledTimes(2); // balanceOf + decimals, once
  });

  it("keeps a holder's tier when the chain cannot be reached", async () => {
    holding(10_000_000);
    const { getTier, _clearTierCache } = await load();
    expect((await getTier(WALLET)).tier.name).toBe("operator");

    // Expire the cache, then break the node.
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000);
    readContract.mockRejectedValue(new Error("rpc down"));

    const r = await getTier(WALLET);
    // Losing your entitlements because a node blinked is not acceptable when you paid for them.
    expect(r.tier.name).toBe("operator");
    expect(r.stale).toBe(true);
    vi.useRealTimers();
    _clearTierCache();
  });

  it("falls back to base when the chain is unreadable and nothing is cached", async () => {
    readContract.mockRejectedValue(new Error("rpc down"));
    const { getTier } = await load();

    const r = await getTier(WALLET);
    // Base is the network exactly as it behaves today, so the worst case of an outage is that
    // nobody gets anything extra. It can never take away what someone already had.
    expect(r.tier.name).toBe("base");
    expect(r.balance).toBeNull();
  });

  it("never throws, whatever the chain does", async () => {
    readContract.mockImplementation(() => { throw new Error("boom"); });
    const { getTier } = await load();

    await expect(getTier(WALLET)).resolves.toBeTruthy();
  });

  it("drops the tier when the tokens are sold", async () => {
    holding(10_000_000);
    const { getTier, _clearTierCache } = await load();
    expect((await getTier(WALLET)).tier.name).toBe("operator");

    _clearTierCache();
    holding(0);
    // Nothing is locked or staked. Sell and the tier goes at the next read, which is the honest
    // behaviour for something that only ever reads a balance.
    expect((await getTier(WALLET)).tier.name).toBe("base");
  });
});
