import { getDb } from "./db";
import { IS_REPORTING_CURRENCY } from "./money";
import { isoHoursAgo } from "./sqlTime";

export interface NetworkStats {
  agents: {
    total: number;
    active: number;
  };
  tasks: {
    total: number;
    completed: number;
    completedToday: number;
    failed: number;
    running: number;
    queued: number;
    /** Over the last SUCCESS_RATE_WINDOW_HOURS, not over all time. */
    successRate: number;
    /** Every task ever settled. Kept for the record; not the headline figure. */
    allTimeSuccessRate: number;
    successRateWindowHours: number;
    weeklyCompleted: number;
    weeklyFailed: number;
    weeklySuccessRate: number;
  };
  capabilities: number;
  payments: {
    totalEthTransacted: number;
    totalTxns: number;
    refundedTxns: number;
    weeklyEthTransacted: number;
    weeklyTxns: number;
  };
  topAgents: { agentId: string; name: string; reputation: number; tasksCompleted: number }[];
  topCapabilities: { capability: string; agentCount: number }[];
  activityByDay: { date: string; completed: number; failed: number }[];
}

/**
 * How many hours of settled tasks the headline success rate is measured over.
 *
 * 24 by default: long enough to smooth over a quiet hour, short enough that a fix shows up the
 * same day. Set AXON_SUCCESS_RATE_WINDOW_HOURS to change it.
 */
/** Below this many settled tasks in the window, the window is too small to draw a rate from. */
const MIN_WINDOW_SAMPLE = 20;

export const SUCCESS_RATE_WINDOW_HOURS = (() => {
  const raw = Number(process.env.AXON_SUCCESS_RATE_WINDOW_HOURS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 24;
})();

let _statsCache: { at: number; data: NetworkStats } | null = null;
// Memoize the heavy aggregate (~9 queries) so the unauthenticated public
// endpoints (/explorer, /status) can't hammer the DB under a flood. Disabled in
// tests so assertions see fresh data immediately after mutations.
const STATS_CACHE_MS = process.env.VITEST ? 0 : 5_000;

export function getNetworkStats(): NetworkStats {
  const now = Date.now();
  if (_statsCache && now - _statsCache.at < STATS_CACHE_MS) return _statsCache.data;
  const data = computeNetworkStats();
  _statsCache = { at: now, data };
  return data;
}

function computeNetworkStats(): NetworkStats {
  const db = getDb();
  // Each query is wrapped so one failure (e.g. a missing column on an out-of-date
  // DB) degrades that metric to a default instead of throwing away the whole bar.
  const safe = <T>(fn: () => T, fallback: T): T => {
    try { return fn(); } catch { return fallback; }
  };

  const agentTotal = safe(() => (db.prepare(`
    SELECT COUNT(*) n FROM agents
  `).get() as { n: number }).n, 0);
  const agentActive = agentTotal;

  const taskCounts = safe(() => db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'completed' AND date(completed_at) = date('now')) AS completed_today,
      COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
      COUNT(*) FILTER (WHERE status = 'running')   AS running,
      COUNT(*) FILTER (WHERE status = 'queued')    AS queued
    FROM tasks
  `).get() as { total: number; completed: number; completed_today: number; failed: number; running: number; queued: number },
  { total: 0, completed: 0, completed_today: 0, failed: 0, running: 0, queued: 0 });

  const capCount = safe(() => (db.prepare(
    "SELECT COUNT(DISTINCT capability) n FROM agent_capabilities"
  ).get() as { n: number }).n, 0);

  // The headline success rate describes how the network is running, so it is measured over a
  // recent window rather than over all time.
  //
  // An all-time rate cannot recover from a bad stretch: a two-day provider outage in September
  // left ~6,800 failures in a ledger of ~26,000 tasks, and with every task from then on
  // succeeding it would still take six figures of new work to drag the number back up. It stops
  // describing the present and starts being a permanent record of the worst thing that happened.
  //
  // The window is in hours and configurable, so it can be widened for a calmer signal or narrowed
  // when something has just been fixed and the question is whether the fix worked.
  const windowStats = safe(() => db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')    AS failed
    FROM tasks
    WHERE completed_at IS NOT NULL
      AND completed_at >= ${isoHoursAgo(SUCCESS_RATE_WINDOW_HOURS)}
  `).get() as { completed: number; failed: number }, { completed: 0, failed: 0 });

  const windowSettled = windowStats.completed + windowStats.failed;
  const allTimeSettled = taskCounts.completed + taskCounts.failed;
  // A handful of tasks is not a rate. Three failures in a quiet night would otherwise be
  // published as 0%, which says far more than the evidence does, so below a floor of settled
  // work the window has nothing useful to report and all-time is what there is.
  const haveEnough = windowSettled >= MIN_WINDOW_SAMPLE;
  const successRate =
    haveEnough
      ? windowStats.completed / windowSettled
      : allTimeSettled > 0
        ? taskCounts.completed / allTimeSettled
        : 0;
  const allTimeSuccessRate = allTimeSettled > 0 ? taskCounts.completed / allTimeSettled : 0;

  const weeklyTasks = safe(() => db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')    AS failed
    FROM tasks
    WHERE date(completed_at) >= date('now', '-6 days')
  `).get() as { completed: number; failed: number }, { completed: 0, failed: 0 });
  const weeklySettled = weeklyTasks.completed + weeklyTasks.failed;
  const weeklySuccessRate = weeklySettled > 0 ? weeklyTasks.completed / weeklySettled : 0;

  const txStats = safe(() => db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'refunded')  AS refunded,
      COALESCE(SUM(amount_eth) FILTER (WHERE status = 'completed' AND ${IS_REPORTING_CURRENCY}), 0) AS eth_transacted
    FROM transactions
  `).get() as { total: number; completed: number; refunded: number; eth_transacted: number },
  { total: 0, completed: 0, refunded: 0, eth_transacted: 0 });

  const weeklyTx = safe(() => db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(amount_eth) FILTER (WHERE status = 'completed' AND ${IS_REPORTING_CURRENCY}), 0) AS eth /* the week's settled total */
    FROM transactions
    WHERE date(settled_at) >= date('now', '-6 days')
  `).get() as { total: number; eth: number }, { total: 0, eth: 0 });

  const topAgents = safe(() => db.prepare(`
    SELECT a.agent_id AS agentId, a.name, a.reputation,
      COUNT(t.task_id) FILTER (WHERE t.status = 'completed') AS tasksCompleted
    FROM agents a
    LEFT JOIN tasks t ON t.to_agent = a.agent_id
    GROUP BY a.agent_id
    ORDER BY a.reputation DESC, tasksCompleted DESC
    LIMIT 5
  `).all() as { agentId: string; name: string; reputation: number; tasksCompleted: number }[], []);

  const topCapabilities = safe(() => db.prepare(`
    SELECT capability, COUNT(*) AS agentCount
    FROM agent_capabilities
    GROUP BY capability
    ORDER BY agentCount DESC, capability ASC
    LIMIT 8
  `).all() as { capability: string; agentCount: number }[], []);

  const activityByDay = safe(() => db.prepare(`
    WITH days AS (
      SELECT date('now', '-6 days') AS date UNION ALL
      SELECT date('now', '-5 days') UNION ALL
      SELECT date('now', '-4 days') UNION ALL
      SELECT date('now', '-3 days') UNION ALL
      SELECT date('now', '-2 days') UNION ALL
      SELECT date('now', '-1 days') UNION ALL
      SELECT date('now')
    )
    SELECT
      d.date,
      COALESCE(SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN t.status = 'failed'    THEN 1 ELSE 0 END), 0) AS failed
    FROM days d
    LEFT JOIN tasks t ON date(t.completed_at) = d.date
    GROUP BY d.date
    ORDER BY d.date ASC
  `).all() as { date: string; completed: number; failed: number }[], []);

  return {
    agents: { total: agentTotal, active: agentActive },
    tasks: {
      total: taskCounts.total,
      completed: taskCounts.completed,
      completedToday: taskCounts.completed_today,
      failed: taskCounts.failed,
      running: taskCounts.running,
      queued: taskCounts.queued,
      successRate: Math.round(successRate * 1000) / 1000,
      allTimeSuccessRate: Math.round(allTimeSuccessRate * 1000) / 1000,
      successRateWindowHours: SUCCESS_RATE_WINDOW_HOURS,
      weeklyCompleted: weeklyTasks.completed,
      weeklyFailed: weeklyTasks.failed,
      weeklySuccessRate: Math.round(weeklySuccessRate * 1000) / 1000,
    },
    capabilities: capCount,
    payments: {
      // Six decimals: an ETH amount is small, and rounding a network total to cents would show
      // zero for a day's real activity.
      totalEthTransacted: Math.round(txStats.eth_transacted * 1e6) / 1e6,
      totalTxns: txStats.total,
      refundedTxns: txStats.refunded,
      weeklyEthTransacted: Math.round(weeklyTx.eth * 1e6) / 1e6,
      weeklyTxns: weeklyTx.total,
    },
    topAgents,
    topCapabilities,
    activityByDay,
  };
}

// ── Daily task + payment stats for the last N days ────────────────────────────

export interface DailyStats {
  date: string;
  tasksCompleted: number;
  tasksFailed: number;
  ethTransacted: number;
  newAgents: number;
}

export function getDailyStats(days = 30): DailyStats[] {
  const db = getDb();

  // Generate a date spine so days with zero activity still appear.
  // Each aggregation uses its own CTE to avoid a Cartesian product when
  // a single day has both tasks and transactions.
  const spine: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    spine.push(`SELECT date('now', '-${i} days') AS d`);
  }

  return db.prepare(`
    WITH
      spine AS (${spine.join(" UNION ALL ")}),
      task_agg AS (
        SELECT date(completed_at) AS d,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'failed')    AS failed
        FROM tasks
        WHERE completed_at IS NOT NULL
        GROUP BY date(completed_at)
      ),
      tx_agg AS (
        SELECT date(settled_at) AS d,
          COALESCE(SUM(amount_eth) FILTER (WHERE status = 'completed' AND ${IS_REPORTING_CURRENCY}), 0) AS eth /* the day's settled total */
        FROM transactions
        WHERE settled_at IS NOT NULL
        GROUP BY date(settled_at)
      ),
      agent_agg AS (
        SELECT date(created_at) AS d, COUNT(*) AS cnt
        FROM agents
        GROUP BY date(created_at)
      )
    SELECT
      s.d AS date,
      COALESCE(ta.completed, 0) AS tasksCompleted,
      COALESCE(ta.failed,    0) AS tasksFailed,
      COALESCE(tx.eth,       0) AS ethTransacted,
      COALESCE(aa.cnt,       0) AS newAgents
    FROM spine s
    LEFT JOIN task_agg  ta ON ta.d = s.d
    LEFT JOIN tx_agg    tx ON tx.d = s.d
    LEFT JOIN agent_agg aa ON aa.d = s.d
    ORDER BY s.d ASC
  `).all() as DailyStats[];
}

// ── All-time leaderboards ─────────────────────────────────────────────────────

export interface AllTimeLeaders {
  topEarners: { agentId: string; name: string; totalEarnedEth: number }[];
  topWorkers: { agentId: string; name: string; tasksCompleted: number; successRate: number }[];
}

export function getAllTimeLeaders(): AllTimeLeaders {
  const db = getDb();

  const topEarners = db.prepare(`
    SELECT a.agent_id AS agentId, a.name,
      COALESCE(SUM(tx.amount_eth) FILTER (WHERE tx.status = 'completed' AND tx.${IS_REPORTING_CURRENCY}), 0)
        AS totalEarnedEth
    FROM agents a
    LEFT JOIN transactions tx ON tx.to_agent = a.agent_id
    GROUP BY a.agent_id
    ORDER BY totalEarnedEth DESC
    LIMIT 10
  `).all() as { agentId: string; name: string; totalEarnedEth: number }[];

  const topWorkers = db.prepare(`
    SELECT
      a.agent_id AS agentId,
      a.name,
      COUNT(t.task_id) FILTER (WHERE t.status = 'completed') AS tasksCompleted,
      ROUND(
        CAST(COUNT(t.task_id) FILTER (WHERE t.status = 'completed') AS REAL)
        / NULLIF(COUNT(t.task_id) FILTER (WHERE t.status IN ('completed','failed')), 0),
        3
      ) AS successRate
    FROM agents a
    LEFT JOIN tasks t ON t.to_agent = a.agent_id
    GROUP BY a.agent_id
    ORDER BY tasksCompleted DESC
    LIMIT 10
  `).all() as { agentId: string; name: string; tasksCompleted: number; successRate: number }[];

  return { topEarners, topWorkers };
}
