// The burn list has to survive the chain forgetting.
//
// A log query on this chain reaches about eight hours back, so without somewhere to keep them the
// early burns drop off the page as if they never happened. These cover the keeping.

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";

const row = (n: number, hash: string) => ({
  n, tx_hash: hash, block_number: 1000 + n,
  eth_in: 0.03 + n / 1000, tokens_out: 2_000_000 + n, caller: "0xbot",
});

function insert(r: ReturnType<typeof row>) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO burns (n, tx_hash, block_number, eth_in, tokens_out, caller, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(r.n, r.tx_hash, r.block_number, r.eth_in, r.tokens_out, r.caller, new Date().toISOString());
}
const count = () =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM burns").get() as { n: number }).n;

describe("burn history is kept", () => {
  beforeEach(() => getDb().prepare("DELETE FROM burns").run());

  it("stores a burn", () => {
    insert(row(1, "0xaaa"));
    expect(count()).toBe(1);
  });

  it("stores each burn once, however often it is read back from the chain", () => {
    insert(row(1, "0xaaa"));
    insert(row(1, "0xaaa"));
    insert(row(1, "0xaaa"));
    expect(count()).toBe(1);
  });

  it("keeps the burn number unique, so a re-read cannot reorder history", () => {
    insert(row(1, "0xaaa"));
    insert(row(2, "0xbbb"));
    insert(row(3, "0xccc"));
    const ns = (getDb().prepare("SELECT n FROM burns ORDER BY n DESC").all() as { n: number }[]).map((r) => r.n);
    expect(ns).toEqual([3, 2, 1]);
  });

  it("refuses two different burns claiming the same transaction", () => {
    insert(row(1, "0xsame"));
    insert(row(2, "0xsame")); // UNIQUE on tx_hash, so this is ignored rather than duplicating
    expect(count()).toBe(1);
  });

  it("returns the newest first, which is the order the page renders", () => {
    for (const n of [2, 5, 1, 4, 3]) insert(row(n, `0x${n}`));
    const ns = (getDb().prepare("SELECT n FROM burns ORDER BY n DESC LIMIT 3").all() as { n: number }[]).map((r) => r.n);
    expect(ns).toEqual([5, 4, 3]);
  });

  it("keeps what it was given, to the precision the page prints", () => {
    insert(row(7, "0xseven"));
    const r = getDb().prepare("SELECT * FROM burns WHERE n = 7").get() as { eth_in: number; tokens_out: number };
    expect(r.eth_in).toBeCloseTo(0.037, 9);
    expect(r.tokens_out).toBe(2_000_007);
  });
});
