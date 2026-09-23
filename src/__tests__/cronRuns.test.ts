import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import {
  noteCronRun,
  noteCronFailure,
  lastRun,
  lastSuccess,
  jobHealth,
  overdueJobs,
  pruneCronRuns,
  EXPECTED_SILENCE_SECONDS,
  TRACKED_JOBS,
} from "@/lib/cronRuns";

/**
 * The ledger exists because of a specific failure: the autonomy pass stopped running on the 20th and
 * nothing noticed until somebody looked at a deploy badge three days later. Two separate jobs were
 * broken, and both failed before reaching their handler, so neither left a log line, an error, or a
 * failed row anywhere. Silence was the only symptom.
 *
 * So these tests are mostly about silence: what it means, when it is allowed, and when it is a fault.
 */

const insertAt = (job: string, iso: string, ok = true) =>
  getDb()
    .prepare("INSERT INTO cron_runs (id, job, started_at, finished_at, ok) VALUES (?, ?, ?, ?, ?)")
    .run(`${job}-${iso}-${Math.random()}`, job, iso, iso, ok ? 1 : 0);

const agoIso = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

describe("the scheduled job ledger", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM cron_runs").run();
  });

  it("records that a job reached its handler", () => {
    noteCronRun("autonomy");

    const run = lastRun("autonomy");
    expect(run?.job).toBe("autonomy");
    expect(run?.ok).toBe(true);
    expect(lastSuccess("autonomy")?.ok).toBe(true);
  });

  it("records a failure without losing the fact that it ran", () => {
    noteCronFailure("telegram-feed", "Telegram API refused the post");

    const run = lastRun("telegram-feed");
    expect(run?.ok).toBe(false);
    expect(run?.detail).toContain("refused");
    // A failed run is still not a success, which is what staleness is measured against.
    expect(lastSuccess("telegram-feed")).toBeNull();
  });

  it("truncates a long error rather than storing an entire stack", () => {
    noteCronFailure("webhooks", "x".repeat(4000));
    expect((lastRun("webhooks")?.detail ?? "").length).toBeLessThanOrEqual(500);
  });

  it("measures silence from the last success, not the last attempt", () => {
    insertAt("health", agoIso(60 * 60 * 6), true);
    insertAt("health", agoIso(30), false); // failing right now

    const health = jobHealth().find((j) => j.job === "health")!;
    // Six hours of real silence, even though something happened thirty seconds ago.
    expect(health.silentFor).toBeGreaterThan(60 * 60 * 5);
    expect(health.overdue).toBe(true);
    expect(health.lastError).toBeNull(); // no detail was stored on that row
  });

  it("reports a job that has never run without calling it overdue", () => {
    const health = jobHealth().find((j) => j.job === "autonomy")!;

    expect(health.neverRun).toBe(true);
    expect(health.silentFor).toBeNull();
    // A fresh database has never heard from anything. A status page that screams on first boot is a
    // status page people learn to ignore.
    expect(health.overdue).toBe(false);
    expect(overdueJobs()).toHaveLength(0);
  });

  it("allows a late job and flags a missing one", () => {
    const allowed = EXPECTED_SILENCE_SECONDS.autonomy;
    insertAt("autonomy", agoIso(allowed - 3600));
    expect(jobHealth().find((j) => j.job === "autonomy")!.overdue).toBe(false);

    getDb().prepare("DELETE FROM cron_runs").run();
    insertAt("autonomy", agoIso(allowed + 3600));
    expect(jobHealth().find((j) => j.job === "autonomy")!.overdue).toBe(true);
  });

  it("catches the failure it was built for: three days of silence on a daily job", () => {
    insertAt("autonomy", agoIso(3 * 86400));

    const overdue = overdueJobs();
    expect(overdue.map((j) => j.job)).toContain("autonomy");
    expect(overdue.find((j) => j.job === "autonomy")!.silentFor).toBeGreaterThan(2 * 86400);
  });

  it("tolerates a late job without letting a dead one hide for days", () => {
    // Two opposing mistakes are possible here and both make the page useless. Too tight and every
    // slow afternoon shows amber until nobody reads it. Too loose and a daily job can be dead for
    // two days before anyone is told, which is the exact failure this table exists to catch.
    // These are the intervals from .railway/railway.ts.
    const schedule: Record<string, number> = {
      autonomy: 86400, retention: 86400, reproducibility: 43200, agents: 86400,
      "demo-activity": 3600, "telegram-feed": 3600, health: 300, webhooks: 300,
    };
    for (const job of TRACKED_JOBS) {
      const window = EXPECTED_SILENCE_SECONDS[job];
      const interval = schedule[job];
      expect(window, `${job} would flag a run that arrived on time`).toBeGreaterThan(interval);
      expect(window, `${job} could stay dead too long unnoticed`).toBeLessThan(interval * 3 + 3600);
    }
  });

  it("prunes old rows and keeps recent ones", () => {
    insertAt("health", agoIso(40 * 86400));
    insertAt("health", agoIso(60));

    expect(pruneCronRuns(30)).toBe(1);
    expect(lastRun("health")).not.toBeNull();
  });

  it("never lets the ledger break the job it is watching", () => {
    getDb().exec("DROP TABLE cron_runs");
    // Writing is best effort: observing a job must not be able to take it down.
    expect(() => noteCronRun("autonomy")).not.toThrow();
    expect(lastRun("autonomy")).toBeNull();
    expect(() => jobHealth()).not.toThrow();

    getDb().exec(`
      CREATE TABLE IF NOT EXISTS cron_runs (
        id TEXT PRIMARY KEY, job TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, ok INTEGER NOT NULL DEFAULT 0, ms INTEGER, detail TEXT
      );
    `);
  });
});
