import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { runRetentionCleanup } from "@/lib/retention";

// The sweep has been deleting rows for months and the file has never once got smaller, because
// SQLite puts deleted pages on a free list inside the file rather than giving them back. What is
// pinned here is that the new tables age out, and that a file carrying real dead weight actually
// shrinks rather than just reporting that it did.

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function launch(token: string, seenAt: string) {
  getDb()
    .prepare(
      `INSERT INTO token_launches (token, creator, curve, block_number, tx_hash, graduated_at, seen_at)
       VALUES (?, '0xcreator', '0xcurve', 1, ?, NULL, ?)
       ON CONFLICT(token) DO NOTHING`,
    )
    .run(token, `0xtx${token}`, seenAt);
}

describe("ageing out the launch index", () => {
  it("drops launches older than the window and keeps recent ones", () => {
    const old = "0xaa00000000000000000000000000000000000001";
    const recent = "0xbb00000000000000000000000000000000000002";
    launch(old, daysAgo(45));
    launch(recent, daysAgo(2));

    const result = runRetentionCleanup();
    expect(result.token_launches).toBeGreaterThanOrEqual(1);

    const rows = getDb()
      .prepare(`SELECT token FROM token_launches WHERE token IN (?, ?)`)
      .all(old, recent) as { token: string }[];
    expect(rows.map((r) => r.token)).toEqual([recent]);
  });

  it("drops a stale scan range with it, so an unread stretch is never mistaken for a read one", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO launch_scan_ranges (from_block, to_block, scanned_at) VALUES (?,?,?)
       ON CONFLICT(from_block, to_block) DO NOTHING`,
    ).run(1_000, 2_000, daysAgo(60));

    runRetentionCleanup();

    const left = db
      .prepare(`SELECT 1 FROM launch_scan_ranges WHERE from_block = 1000 AND to_block = 2000`)
      .get();
    expect(left).toBeUndefined();
  });

  it("reports a reclaim figure rather than leaving the caller guessing", () => {
    const result = runRetentionCleanup();
    expect(typeof result.reclaimed_mb).toBe("number");
    expect(result.reclaimed_mb).toBeGreaterThanOrEqual(0);
  });
});

describe("what reclaiming actually does to the file", () => {
  it("a delete alone leaves the pages in the file, and VACUUM is what gives them back", () => {
    const db = getDb();
    const one = (sql: string) => Number(Object.values(db.prepare(sql).get() as object)[0]);

    // auto_vacuum off is the whole reason this is needed. If this ever flips, the sweep's
    // reclaim step is redundant and should be reconsidered rather than left running.
    expect(one("PRAGMA auto_vacuum")).toBe(0);

    db.exec(`CREATE TABLE IF NOT EXISTS __reclaim_probe (id INTEGER PRIMARY KEY, blob TEXT)`);
    const insert = db.prepare(`INSERT INTO __reclaim_probe (blob) VALUES (?)`);
    const filler = "x".repeat(4000);
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) insert.run(filler);
    })();

    const grown = one("PRAGMA page_count");
    db.exec(`DELETE FROM __reclaim_probe`);

    // The rows are gone but the file is exactly as big as it was: this is the leak.
    expect(one("PRAGMA page_count")).toBe(grown);
    expect(one("PRAGMA freelist_count")).toBeGreaterThan(0);

    db.exec("VACUUM");
    expect(one("PRAGMA page_count")).toBeLessThan(grown);
    expect(one("PRAGMA freelist_count")).toBe(0);

    db.exec(`DROP TABLE IF EXISTS __reclaim_probe`);
  });
});
