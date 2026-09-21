import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Holder balances are rebuilt from the token's own Transfer log. If that arithmetic is wrong the
// page publishes a false claim about who controls somebody's token, so the sums are pinned here
// against a hand-built log rather than trusted to a live read.

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CURVE = "0xcccccccccccccccccccccccccccccccccccccccc";
const CREATOR = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const WHALE = "0x1111111111111111111111111111111111111111";
const SMALL = "0x2222222222222222222222222222222222222222";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";

const pad = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const transfer = (from: string, to: string, value: bigint) => ({
  topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(from), pad(to)],
  data: word(value),
});

const E = (n: number) => BigInt(n) * 10n ** 18n;
const SUPPLY = E(1_000_000_000).toString();

let logs: ReturnType<typeof transfer>[] = [];

vi.mock("@/lib/evm", () => ({
  withRpc: async (fn: (request: <T>(m: string, p: unknown[]) => Promise<T>) => unknown) =>
    fn(async <T,>(method: string): Promise<T> => {
      if (method === "eth_blockNumber") return "0x1" as T;
      if (method === "eth_getLogs") return logs as T;
      throw new Error(`unexpected ${method}`);
    }),
}));

const { holderReport, clearHolderCache } = await import("@/lib/tokenHolders");

// Results are cached by token address, and every case here uses the same one, so without this
// each test would be handed the first test's answer.
beforeEach(() => { logs = []; clearHolderCache(); });
afterEach(() => { vi.clearAllMocks(); });

describe("rebuilding holders from the transfer log", () => {
  it("mints from the zero address and moves balances between wallets", async () => {
    logs = [
      transfer(ZERO, CURVE, E(1_000_000_000)),   // the curve starts with everything
      transfer(CURVE, WHALE, E(400_000_000)),
      transfer(CURVE, SMALL, E(100_000_000)),
      transfer(WHALE, DEAD, E(50_000_000)),      // some burned
    ];

    const r = await holderReport(TOKEN, SUPPLY, 0, { curve: CURVE, creator: CREATOR });
    expect(r.available).toBe(true);
    expect(r.transfersRead).toBe(4);

    const by = Object.fromEntries(r.holders.map((h) => [h.address, h]));
    expect(by[CURVE].share).toBeCloseTo(0.5, 5);   // 500m left on the curve
    expect(by[WHALE].share).toBeCloseTo(0.35, 5);  // 400m in, 50m burned
    expect(by[SMALL].share).toBeCloseTo(0.1, 5);
    expect(by[DEAD].share).toBeCloseTo(0.05, 5);
  });

  it("labels the curve, the creator and the burn, so a big row is not misread", async () => {
    logs = [
      transfer(ZERO, CURVE, E(900_000_000)),
      transfer(ZERO, CREATOR, E(50_000_000)),
      transfer(ZERO, DEAD, E(50_000_000)),
    ];
    const r = await holderReport(TOKEN, SUPPLY, 0, { curve: CURVE, creator: CREATOR });
    const by = Object.fromEntries(r.holders.map((h) => [h.address, h.label]));
    expect(by[CURVE]).toBe("bonding curve");
    expect(by[CREATOR]).toBe("creator");
    expect(by[DEAD]).toBe("burned");
  });

  it("leaves the curve and burned supply out of the concentration figure", async () => {
    // Nobody has bought any of this. Counting the curve would report 100% concentration and make
    // an untraded token look like one wallet owns it.
    logs = [transfer(ZERO, CURVE, E(1_000_000_000))];
    const r = await holderReport(TOKEN, SUPPLY, 0, { curve: CURVE, creator: CREATOR });
    expect(r.topTenShare).toBe(0);
  });

  it("counts a real whale into the concentration figure", async () => {
    logs = [
      transfer(ZERO, CURVE, E(1_000_000_000)),
      transfer(CURVE, WHALE, E(880_000_000)),
    ];
    const r = await holderReport(TOKEN, SUPPLY, 0, { curve: CURVE, creator: CREATOR });
    expect(r.topTenShare).toBeCloseTo(0.88, 5);
  });

  it("does not count the dead address as a holder", async () => {
    logs = [
      transfer(ZERO, WHALE, E(500_000_000)),
      transfer(ZERO, DEAD, E(500_000_000)),
    ];
    const r = await holderReport(TOKEN, SUPPLY, 0, { curve: CURVE, creator: CREATOR });
    expect(r.holderCount).toBe(1);
  });

  it("refuses rather than guessing when the launch block is unknown", async () => {
    const r = await holderReport(TOKEN, SUPPLY, null, {});
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/launch block/i);
  });

  it("refuses when the token reports no supply, since every share would divide by zero", async () => {
    const r = await holderReport(TOKEN, null, 0, {});
    expect(r.available).toBe(false);
  });

  it("ignores zero-value transfers, which some contracts emit on approval paths", async () => {
    logs = [transfer(ZERO, WHALE, E(100)), transfer(WHALE, SMALL, 0n)];
    const r = await holderReport(TOKEN, SUPPLY, 0, {});
    expect(r.transfersRead).toBe(1);
    expect(r.holders.map((h) => h.address)).not.toContain(SMALL);
  });
});

describe("the cache", () => {
  it("serves a repeat read without touching the chain again", async () => {
    logs = [transfer(ZERO, WHALE, E(1_000_000_000))];
    const first = await holderReport(TOKEN, SUPPLY, 0, {});
    expect(first.transfersRead).toBe(1);

    // If this went back to the node it would now see nothing and report an empty list.
    logs = [];
    const second = await holderReport(TOKEN, SUPPLY, 0, {});
    expect(second.transfersRead).toBe(1);
    expect(second.holders[0].address).toBe(WHALE);
  });

  it("reads again once cleared, so stale balances cannot outlive the window", async () => {
    logs = [transfer(ZERO, WHALE, E(1_000_000_000))];
    await holderReport(TOKEN, SUPPLY, 0, {});

    clearHolderCache();
    logs = [transfer(ZERO, SMALL, E(1_000_000_000))];
    const fresh = await holderReport(TOKEN, SUPPLY, 0, {});
    expect(fresh.holders[0].address).toBe(SMALL);
  });
});
