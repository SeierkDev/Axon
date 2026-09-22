// Ageing data out, and actually giving the space back.
//
// The sweep below has been deleting rows for months. The database file has never once got
// smaller, because SQLite does not reclaim deleted pages unless it is asked: the space goes on a
// free list inside the file and is reused by later writes, but the file itself only ever grows.
// auto_vacuum is off, and nothing anywhere called VACUUM, so a table that churns hard leaves the
// file permanently at its high water mark. On a volume with a fixed size that is a leak with a
// deadline on it.
//
// So the sweep now finishes by asking how much of the file is dead weight, and reclaims it when
// there is enough to be worth the rewrite.

import { getDb } from "./db";
import { logger } from "./logger";

export interface RetentionResult {
  webhook_deliveries: number;
  audit_events: number;
  agent_metrics: number;
  spend_alerts: number;
  telegram_posts: number;
  error_log: number;
  rate_limit_windows: number;
  task_progress: number;
  trace_events: number;
  /** the launch index, which grows by whatever people look up */
  token_launches: number;
  launch_scan_ranges: number;
  /** megabytes handed back to the filesystem, 0 when nothing was worth reclaiming */
  reclaimed_mb: number;
}

export function runRetentionCleanup(): RetentionResult {
  const db = getDb();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const nowMs = Date.now();

  const counts = db.transaction((): Omit<RetentionResult, "reclaimed_mb"> => {
    const webhook_deliveries = db
      .prepare(
        `DELETE FROM webhook_deliveries
         WHERE status IN ('delivered', 'failed')
         AND created_at < ?`
      )
      .run(thirtyDaysAgo).changes;

    const audit_events = db
      .prepare(`DELETE FROM audit_events WHERE created_at < ?`)
      .run(ninetyDaysAgo).changes;

    const agent_metrics = db
      .prepare(`DELETE FROM agent_metrics WHERE window_start < ?`)
      .run(ninetyDaysAgo).changes;

    const spend_alerts = db
      .prepare(`DELETE FROM spend_alerts WHERE fired_at < ?`)
      .run(ninetyDaysAgo).changes;

    // idx_telegram_posts_created covers this
    const telegram_posts = db
      .prepare(`DELETE FROM telegram_posts WHERE created_at < ?`)
      .run(ninetyDaysAgo).changes;

    const error_log = db
      .prepare(`DELETE FROM error_log WHERE ts < ?`)
      .run(thirtyDaysAgo).changes;

    // reset_at is epoch milliseconds
    const rate_limit_windows = db
      .prepare(`DELETE FROM rate_limit_windows WHERE reset_at < ?`)
      .run(nowMs).changes;

    const task_progress = db
      .prepare(
        `DELETE FROM task_progress
         WHERE task_id IN (
           SELECT task_id FROM tasks
           WHERE completed_at IS NOT NULL
           AND completed_at < ?
         )`
      )
      .run(thirtyDaysAgo).changes;

    // Execution traces age out with their tasks, same window as progress.
    const trace_events = db
      .prepare(
        `DELETE FROM trace_events
         WHERE task_id IN (
           SELECT task_id FROM tasks
           WHERE completed_at IS NOT NULL
           AND completed_at < ?
         )`
      )
      .run(thirtyDaysAgo).changes;

    // The launch index fills itself as people look tokens up, on a chain doing around twenty
    // thousand launches a day. Nothing read it after the report that caused it to be written, and
    // nothing aged it out either. The scan ranges go with it: keeping a range that says a window
    // was read, after its rows are gone, would make an empty stretch look like a read one.
    const token_launches = db
      .prepare(`DELETE FROM token_launches WHERE seen_at < ?`)
      .run(thirtyDaysAgo).changes;

    const launch_scan_ranges = db
      .prepare(`DELETE FROM launch_scan_ranges WHERE scanned_at < ?`)
      .run(thirtyDaysAgo).changes;

    return {
      webhook_deliveries,
      audit_events,
      agent_metrics,
      spend_alerts,
      telegram_posts,
      error_log,
      rate_limit_windows,
      task_progress,
      trace_events,
      token_launches,
      launch_scan_ranges,
    };
  })();

  // VACUUM rewrites the whole file and takes an exclusive lock, so it is not something to do on
  // every sweep. It runs only when a real share of the file is dead weight, and only while the
  // file is small enough that the rewrite is quick. Both conditions failing is the normal case.
  return { ...counts, reclaimed_mb: reclaimIfWorthIt() };
}

/** Share of the file that must be free before a rewrite earns its lock. */
const WASTE_THRESHOLD = 0.2;

/** Above this the rewrite is long enough that it wants a maintenance window, not a cron tick. */
const MAX_VACUUM_MB = 512;

/**
 * Give the free pages back, if there are enough of them to matter.
 *
 * Returns megabytes reclaimed, or 0 when it decided not to. Never throws: a failed reclaim is a
 * file that stays the size it already was, which is exactly where it was a moment ago.
 */
function reclaimIfWorthIt(): number {
  try {
    const db = getDb();
    const one = (sql: string) => Number(Object.values(db.prepare(sql).get() as object)[0]);

    const pageSize = one("PRAGMA page_size");
    const before = one("PRAGMA page_count");
    const free = one("PRAGMA freelist_count");
    if (before === 0) return 0;

    const mb = (pages: number) => (pages * pageSize) / 1_048_576;
    const waste = free / before;

    if (waste < WASTE_THRESHOLD || mb(before) > MAX_VACUUM_MB) {
      logger.info("retention.reclaim_skipped", "Left the file as it is", {
        sizeMb: Number(mb(before).toFixed(1)),
        wastePercent: Number((waste * 100).toFixed(1)),
      });
      return 0;
    }

    db.exec("VACUUM");
    const after = one("PRAGMA page_count");
    const reclaimed = Number((mb(before) - mb(after)).toFixed(1));

    logger.info("retention.reclaimed", "Gave space back to the filesystem", {
      beforeMb: Number(mb(before).toFixed(1)),
      afterMb: Number(mb(after).toFixed(1)),
      reclaimedMb: reclaimed,
    });
    return reclaimed;
  } catch (err) {
    logger.warn("retention.reclaim_failed", "Could not reclaim space", { err });
    return 0;
  }
}
