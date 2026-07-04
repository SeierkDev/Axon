import { getDb } from "./db";

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
}

export function runRetentionCleanup(): RetentionResult {
  const db = getDb();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const nowMs = Date.now();

  return db.transaction((): RetentionResult => {
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
    };
  })();
}
