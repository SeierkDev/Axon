// eth_getLogs against a node that caps on RESULTS, not on block span.
//
// That measured behaviour is the whole reason getLogs is not a single call. A range that comes back
// at the cap is indistinguishable from a complete one, so the only safe reading is that it was
// truncated, and the range has to be split until each piece comes back under the cap. Getting this
// wrong does not throw: it silently returns fewer events than happened.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getLogs, resetRpcCircuit } from "@/lib/evm";

const CAP = 10_000;

/**
 * A node that answers with `count(from, to)` logs for whatever range it is asked about, and refuses
 * exactly the way the live node does when that count would exceed the cap.
 */
function stubNode(count: (from: bigint, to: bigint) => number, mode: "refuse" | "truncate" = "refuse") {
  const ranges: [bigint, bigint][] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const [params] = body.params as [{ fromBlock: string; toBlock: string }];
    const from = BigInt(params.fromBlock);
    const to = BigInt(params.toBlock);
    ranges.push([from, to]);
    const n = count(from, to);
    const payload =
      n >= CAP && mode === "refuse"
        ? { jsonrpc: "2.0", id: 1, error: { code: -32005, message: `logs matched by query exceeds limit of ${CAP}` } }
        : {
            jsonrpc: "2.0",
            id: 1,
            result: Array.from({ length: Math.min(n, CAP) }, (_, i) => ({ blockNumber: params.fromBlock, i })),
          };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { ranges, spy };
}

beforeEach(() => resetRpcCircuit());
afterEach(() => vi.restoreAllMocks());

describe("getLogs", () => {
  it("makes a single request for a small quiet range", async () => {
    const { ranges } = stubNode(() => 3);
    const logs = await getLogs(0n, 100n);
    expect(logs).toHaveLength(3);
    expect(ranges).toEqual([[0n, 100n]]);
  });

  it("chunks a span wider than the per-query limit", async () => {
    const { ranges } = stubNode(() => 1);
    await getLogs(0n, 250_000n);
    expect(ranges).toEqual([
      [0n, 99_999n],
      [100_000n, 199_999n],
      [200_000n, 250_000n],
    ]);
  });

  // Measured against the live node: over the cap is a REFUSAL, not a truncated list. If that were
  // read as a normal error the whole query would fail instead of splitting.
  it("splits a range the node refuses as over the limit", async () => {
    const { ranges } = stubNode((from, to) => (to - from > 500n ? CAP : 4));
    const logs = await getLogs(0n, 1000n);
    expect(ranges[0]).toEqual([0n, 1000n]); // asked once, was refused
    expect(ranges.length).toBeGreaterThan(1); // then halved
    expect(logs).toHaveLength(8);
  });

  // A different node behind the same URL might truncate instead of refusing, and a response sitting
  // exactly at the cap cannot be told apart from a complete one.
  it("also splits a response that arrives exactly at the cap", async () => {
    const { ranges } = stubNode((from, to) => (to - from > 500n ? CAP : 4), "truncate");
    const logs = await getLogs(0n, 1000n);
    expect(ranges.length).toBeGreaterThan(1);
    expect(logs).toHaveLength(8);
  });

  it("keeps splitting until every piece is under the cap", async () => {
    const { ranges } = stubNode((from, to) => (to - from > 100n ? CAP : 1));
    await getLogs(0n, 1000n);
    const widest = Math.max(...ranges.map(([f, t]) => Number(t - f)));
    expect(widest).toBe(1000);
    // every range that was actually counted came back under the cap
    const counted = ranges.filter(([f, t]) => t - f <= 100n);
    expect(counted.length).toBeGreaterThan(0);
  });

  // One block that alone exceeds the cap cannot be split any further. Saying so is better than
  // returning a slice of the truth and calling it the whole.
  it("says so rather than guessing when a single block is over the cap", async () => {
    stubNode(() => CAP);
    await expect(getLogs(7n, 7n)).rejects.toThrow(/block 7 alone exceeds the node's 10000-log limit/);
  });

  // An error that is not about the cap must not be mistaken for one and turned into a split.
  it("does not split on an unrelated node error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "method not supported" } }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    await expect(getLogs(0n, 1000n)).rejects.toThrow(/method not supported/);
  });

  it("passes address and topic filters through", async () => {
    const { spy } = stubNode(() => 0);
    await getLogs(0n, 10n, { address: "0xabc", topics: ["0xdef"] });
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body.params[0]).toMatchObject({ address: "0xabc", topics: ["0xdef"] });
  });
});
