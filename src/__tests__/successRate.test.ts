// The headline success rate, and the timestamp comparison underneath it.

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { isoHoursAgo, ISO_HOURS_AGO_PARAM } from "@/lib/sqlTime";
import { isPermanentModelError } from "@/lib/modelHealth";

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();

let seq = 0;
function task(status: "completed" | "failed", hoursAgo: number) {
  const id = `sr-${++seq}`;
  getDb()
    .prepare(
      `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, completed_at, created_at)
       VALUES (?, 'a', 'b', 't', ?, ?, ?)`,
    )
    .run(id, status, at(hoursAgo), at(hoursAgo));
}

describe("a cutoff compares against the format we actually store", () => {
  // SQLite's datetime() gives "2026-09-18 17:19:01" while the app stores
  // "2026-09-18T15:19:01.626Z". Compared as strings, the "T" beats the " " at the tenth
  // character, so on the cutoff's own date every stored time reads as later than the cutoff,
  // however early in the day it was. The window silently grew by a day.
  it("excludes a row from earlier on the cutoff's own date", () => {
    const db = getDb();
    const bad = db
      .prepare("SELECT ? >= datetime('now','-24 hours') AS hit")
      .get("2026-09-18T15:19:01.626Z") as { hit: number };
    const good = db
      .prepare(`SELECT ? >= ${isoHoursAgo(24)} AS hit`)
      .get("2026-09-18T15:19:01.626Z") as { hit: number };

    // Pinned so the old spelling cannot quietly come back: it says yes to a 2026 date only
    // because of the byte comparison, and the fixed one agrees with the calendar.
    expect(bad.hit).toBe(1);
    expect(good.hit).toBe(0);
  });

  it("keeps a row that really is inside the window", () => {
    const db = getDb();
    const row = db.prepare(`SELECT ? >= ${isoHoursAgo(24)} AS hit`).get(at(2)) as { hit: number };
    expect(row.hit).toBe(1);
  });

  it("does the same when the offset is a bound parameter", () => {
    const db = getDb();
    const inside = db.prepare(`SELECT ? >= ${ISO_HOURS_AGO_PARAM} AS hit`).get(at(2), 24) as { hit: number };
    const outside = db.prepare(`SELECT ? >= ${ISO_HOURS_AGO_PARAM} AS hit`).get(at(48), 24) as { hit: number };
    expect(inside.hit).toBe(1);
    expect(outside.hit).toBe(0);
  });
});

describe("the success rate describes the window, not all of history", () => {
  beforeEach(() => {
    // Isolated in-memory DB per file, so this only clears the seeded rows that would
    // otherwise sit inside the window and blur what each case is measuring.
    getDb().prepare("DELETE FROM tasks").run();
  });

  it("does not let an old bad stretch hold the current figure down", async () => {
    // A long healthy history, a bad stretch two days ago, and a healthy present.
    for (let i = 0; i < 200; i++) task("completed", 300 + i);
    for (let i = 0; i < 400; i++) task("failed", 40 + (i % 20));
    for (let i = 0; i < 19; i++) task("completed", 1 + (i % 10));
    task("failed", 3);

    const { getNetworkStats } = await import("@/lib/analytics");
    const t = getNetworkStats().tasks;

    // 19 of 20 inside the window, regardless of the 400 failures that sit outside it.
    expect(t.successRate).toBeGreaterThan(0.9);
    // and the all-time figure is still reported, just not as the headline
    expect(t.allTimeSuccessRate).toBeLessThan(t.successRate);
    expect(t.successRateWindowHours).toBeGreaterThan(0);
  });

  it("does not publish a rate off a handful of tasks", async () => {
    // A quiet night with three failures is not a 0% network. Below the sample floor the
    // window has nothing to say and the all-time figure is reported instead.
    for (let i = 0; i < 300; i++) task("completed", 300 + i);
    for (let i = 0; i < 3; i++) task("failed", 2);

    const { getNetworkStats } = await import("@/lib/analytics");
    const t = getNetworkStats().tasks;
    expect(t.successRate).toBeGreaterThan(0.5);
    expect(t.successRate).toBeCloseTo(t.allTimeSuccessRate, 3);
  });
});

describe("a model the provider refuses is told apart from a bad day", () => {
  it("recognises what each provider says about an unknown model", () => {
    expect(isPermanentModelError("The model `gpt5.5` does not exist or you do not have access to it.")).toBe(true);
    expect(isPermanentModelError('{"code":"not-found","error":"The model grok 4.7 does not exist"}')).toBe(true);
    expect(isPermanentModelError('{"error":{"code":"model_not_found"}}')).toBe(true);
    expect(isPermanentModelError("invalid model: ID")).toBe(true);
  });

  it("leaves everything that is not about the model alone", () => {
    // These all come right on their own, or with a fix that has nothing to do with the agent.
    expect(isPermanentModelError('401 {"type":"authentication_error","message":"API key is invalid."}')).toBe(false);
    expect(isPermanentModelError("429 rate_limit_error: slow down")).toBe(false);
    expect(isPermanentModelError("Request timed out after 60000ms")).toBe(false);
    expect(isPermanentModelError("529 overloaded_error")).toBe(false);
    expect(isPermanentModelError("fetch failed")).toBe(false);
    expect(isPermanentModelError("")).toBe(false);
  });

  it("does not mistake a 404 that is really an auth failure", () => {
    expect(isPermanentModelError('404 authentication_error: API key is invalid')).toBe(false);
  });
});
