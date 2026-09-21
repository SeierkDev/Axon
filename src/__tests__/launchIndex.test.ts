import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { creatorHistory, LAUNCHPAD_FACTORY } from "@/lib/launchIndex";

// The index answers "who launched this, and what else have they launched". The number it reports
// is only as complete as the windows actually read, so what is pinned here is that it never
// overstates: a wallet's history must never look smaller or larger than the data supports.

function launch(token: string, creator: string, block: number, graduatedAt: number | null = null) {
  getDb()
    .prepare(
      `INSERT INTO token_launches (token, creator, curve, block_number, tx_hash, graduated_at, seen_at)
       VALUES (?, ?, '0xcurve', ?, '0xtx', ?, '2026-09-21T00:00:00.000Z')
       ON CONFLICT(token) DO NOTHING`,
    )
    .run(token, creator, block, graduatedAt);
}

const SERIAL = "0x9e2c20aaa4ecb61c41dc090d1f28bf24b1c38807";
const ONCE = "0x3e5e52d88349d5244c428a3bc9b8721e49ef64f8";

beforeEach(() => {
  getDb().prepare("DELETE FROM token_launches").run();
  getDb().prepare("DELETE FROM launch_scan_ranges").run();
});

describe("what a wallet has launched before", () => {
  it("counts a serial launcher's tokens and how few of them went anywhere", () => {
    for (let i = 0; i < 12; i++) launch(`0xaa${String(i).padStart(38, "0")}`, SERIAL, 68_000_000 + i);
    launch("0xbb00000000000000000000000000000000000001", SERIAL, 68_000_099, 68_000_500);

    const h = creatorHistory(SERIAL);
    expect(h.total).toBe(13);
    expect(h.graduated).toBe(1);
    expect(h.launches[0].blockNumber).toBe(68_000_099); // newest first
  });

  it("keeps wallets apart", () => {
    launch("0xaa00000000000000000000000000000000000001", SERIAL, 68_000_001);
    launch("0xcc00000000000000000000000000000000000001", ONCE, 68_000_002);

    expect(creatorHistory(SERIAL).total).toBe(1);
    expect(creatorHistory(ONCE).total).toBe(1);
  });

  it("reports how far back the count goes, so a small number is not mistaken for a clean record", () => {
    launch("0xaa00000000000000000000000000000000000001", ONCE, 68_900_000);
    expect(creatorHistory(ONCE).indexedFromBlock).toBeNull(); // nothing scanned yet: unknown

    getDb()
      .prepare(`INSERT INTO launch_scan_ranges (from_block, to_block, scanned_at) VALUES (?,?,?)`)
      .run(68_800_000, 68_900_000, "2026-09-21T00:00:00.000Z");

    expect(creatorHistory(ONCE).indexedFromBlock).toBe(68_800_000);
  });

  it("never double counts a token seen in two overlapping windows", () => {
    launch("0xaa00000000000000000000000000000000000001", SERIAL, 68_000_001);
    launch("0xaa00000000000000000000000000000000000001", SERIAL, 68_000_001);
    expect(creatorHistory(SERIAL).total).toBe(1);
  });

  it("returns an empty history rather than throwing for a wallet it has never seen", () => {
    const h = creatorHistory("0x000000000000000000000000000000000000dead");
    expect(h.total).toBe(0);
    expect(h.launches).toEqual([]);
  });
});

describe("the factory it reads", () => {
  it("is Pons v2 on Robinhood Chain, lowercased for comparison", () => {
    expect(LAUNCHPAD_FACTORY).toBe("0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e");
  });
});
