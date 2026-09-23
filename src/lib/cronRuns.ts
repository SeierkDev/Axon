// Whether the scheduled jobs are actually running.
//
// The status page watched the database, the worker and the throughput. It did not watch the jobs that
// keep those things fed, so when the autonomy pass began failing on the 20th it went unnoticed until
// somebody happened to look at a deploy badge three days later. The failure was silent in the worst
// way: a cron that errors and a cron that has not fired yet both produce nothing at all.
//
// So each job writes down that it ran. What this module then reports is not "did a run fail" but "how
// long has it been since one finished", because a job that stopped being scheduled leaves no failures
// behind to count.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";

export interface CronRun {
  job: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  ms: number | null;
  detail: string | null;
}

/**
 * How long a job may stay silent before something is wrong, in seconds.
 *
 * Each is its schedule plus generous room, because a late job is normal and a missing one is not. The
 * point is to catch a job that has stopped, not to page anyone over a slow afternoon, so every window
 * here is at least twice the interval it covers.
 */
export const EXPECTED_SILENCE_SECONDS: Record<string, number> = {
  autonomy: 60 * 60 * 30, // daily at 07:00
  retention: 60 * 60 * 30, // daily at 02:00
  reproducibility: 60 * 60 * 18, // twice a day
  agents: 60 * 60 * 30, // daily at 06:00
  "demo-activity": 60 * 60 * 3, // hourly
  "telegram-feed": 60 * 60 * 3, // hourly
  health: 60 * 20, // every 5 minutes
  webhooks: 60 * 20, // every 5 minutes
};

/** The jobs this module expects to hear from, in a stable order for display. */
export const TRACKED_JOBS = Object.keys(EXPECTED_SILENCE_SECONDS);

/**
 * Write down that a job reached its handler.
 *
 * Called once the request is past authentication, which is the moment that actually distinguishes a
 * working job from a broken one. Both of the failures this ledger was built for died before this
 * point: one sent an unexpanded "Bearer $CRON_SECRET" and was refused, the other called a URL with no
 * route behind it. Neither left a trace anywhere, and neither would have written a row here.
 *
 * Deliberately a single statement rather than a wrapper around each handler. A wrapper would have
 * meant restructuring eight routes that all work, to observe them better, which is a poor trade.
 */
export function noteCronRun(job: string, detail?: string): void {
  write(job, true, detail ?? null);
}

/** For the routes that already catch their own errors, so a job that ran and failed says so. */
export function noteCronFailure(job: string, detail: string): void {
  write(job, false, detail.slice(0, 500));
}

function write(job: string, ok: boolean, detail: string | null): void {
  safely(() => {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO cron_runs (id, job, started_at, finished_at, ok, ms, detail) VALUES (?, ?, ?, ?, ?, NULL, ?)",
      )
      .run(randomUUID(), job, now, now, ok ? 1 : 0, detail);
  });
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* the ledger must never be the reason a job fails */
  }
}

/** The most recent run of a job, finished or not. */
export function lastRun(job: string): CronRun | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT job, started_at, finished_at, ok, ms, detail
           FROM cron_runs WHERE job = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(job) as
      | { job: string; started_at: string; finished_at: string | null; ok: number; ms: number | null; detail: string | null }
      | undefined;
    if (!row) return null;
    return {
      job: row.job,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      ok: row.ok === 1,
      ms: row.ms,
      detail: row.detail,
    };
  } catch {
    return null;
  }
}

/** The most recent run of a job that actually succeeded. */
export function lastSuccess(job: string): CronRun | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT job, started_at, finished_at, ok, ms, detail
           FROM cron_runs WHERE job = ? AND ok = 1 ORDER BY started_at DESC LIMIT 1`,
      )
      .get(job) as
      | { job: string; started_at: string; finished_at: string | null; ok: number; ms: number | null; detail: string | null }
      | undefined;
    if (!row) return null;
    return {
      job: row.job,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      ok: row.ok === 1,
      ms: row.ms,
      detail: row.detail,
    };
  } catch {
    return null;
  }
}

export interface JobHealth {
  job: string;
  /** seconds since the last successful run, or null if there has never been one */
  silentFor: number | null;
  allowed: number;
  overdue: boolean;
  /** true when the job has never reported at all, which is also how a brand new deployment looks */
  neverRun: boolean;
  lastError: string | null;
}

/**
 * One line per tracked job.
 *
 * A job that has never run is reported but not counted as overdue. On a fresh database every job looks
 * silent, and a status page that screams on first boot is a status page people learn to ignore.
 */
export function jobHealth(now: Date = new Date()): JobHealth[] {
  return TRACKED_JOBS.map((job) => {
    const allowed = EXPECTED_SILENCE_SECONDS[job];
    const success = lastSuccess(job);
    const latest = lastRun(job);
    const lastError = latest && !latest.ok && latest.finishedAt ? latest.detail : null;

    if (!success) {
      return { job, silentFor: null, allowed, overdue: false, neverRun: true, lastError };
    }

    const silentFor = Math.max(0, Math.round((now.getTime() - Date.parse(success.startedAt)) / 1000));
    return { job, silentFor, allowed, overdue: silentFor > allowed, neverRun: false, lastError };
  });
}

/** Jobs that have gone quiet for longer than their schedule allows. */
export function overdueJobs(now: Date = new Date()): JobHealth[] {
  return jobHealth(now).filter((j) => j.overdue);
}

/** Keeps the ledger from growing without limit. Called by the retention pass. */
export function pruneCronRuns(keepDays = 30): number {
  try {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    return getDb().prepare("DELETE FROM cron_runs WHERE started_at < ?").run(cutoff).changes ?? 0;
  } catch {
    return 0;
  }
}
