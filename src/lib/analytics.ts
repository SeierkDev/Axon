import { getDb } from "./db";

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
    successRate: number;
    weeklyCompleted: number;
    weeklyFailed: number;
    weeklySuccessRate: number;
  };
  capabilities: number;
  payments: {
    totalUsdcTransacted: number;
    totalSolTransacted: number;
    totalTxns: number;
    refundedTxns: number;
    weeklyUsdcTransacted: number;
    weeklyTxns: number;
  };
  topAgents: { agentId: string; name: string; reputation: number; tasksCompleted: number }[];
  topCapabilities: { capability: string; agentCount: number }[];
  activityByDay: { date: string; completed: number; failed: number }[];
}

export function getNetworkStats(): NetworkStats {
  const db = getDb();

  const agentTotal = (db.prepare(`
    SELECT COUNT(*) n FROM agents
    WHERE endpoint IS NULL
       OR verification_status IN ('reachable', 'x402_compliant', 'platform')
  `).get() as { n: number }).n;
  const agentActive = agentTotal;

  const taskCounts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'completed' AND date(completed_at) = date('now')) AS completed_today,
      COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
      COUNT(*) FILTER (WHERE status = 'running')   AS running,
      COUNT(*) FILTER (WHERE status = 'queued')    AS queued
    FROM tasks
  `).get() as { total: number; completed: number; completed_today: number; failed: number; running: number; queued: number };

  const capCount = (db.prepare(
    "SELECT COUNT(DISTINCT capability) n FROM agent_capabilities"
  ).get() as { n: number }).n;

  const settled = taskCounts.completed + taskCounts.failed;
  const successRate = settled > 0 ? taskCounts.completed / settled : 0;

  const weeklyTasks = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')    AS failed
    FROM tasks
    WHERE date(completed_at) >= date('now', '-6 days')
  `).get() as { completed: number; failed: number };
  const weeklySettled = weeklyTasks.completed + weeklyTasks.failed;
  const weeklySuccessRate = weeklySettled > 0 ? weeklyTasks.completed / weeklySettled : 0;

  const txStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'refunded')  AS refunded,
      COALESCE(SUM(amount_sol) FILTER (WHERE status = 'completed' AND currency = 'USDC'), 0) AS usdc_transacted,
      COALESCE(SUM(amount_sol) FILTER (WHERE status = 'completed' AND currency = 'SOL'),  0) AS sol_transacted
    FROM transactions
  `).get() as { total: number; completed: number; refunded: number; usdc_transacted: number; sol_transacted: number };

  const weeklyTx = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(amount_sol) FILTER (WHERE status = 'completed' AND currency = 'USDC'), 0) AS usdc
    FROM transactions
    WHERE date(settled_at) >= date('now', '-6 days')
  `).get() as { total: number; usdc: number };

  const topAgents = db.prepare(`
    SELECT a.agent_id AS agentId, a.name, a.reputation,
      COUNT(t.task_id) FILTER (WHERE t.status = 'completed') AS tasksCompleted
    FROM agents a
    LEFT JOIN tasks t ON t.to_agent = a.agent_id
    GROUP BY a.agent_id
    ORDER BY a.reputation DESC, tasksCompleted DESC
    LIMIT 5
  `).all() as { agentId: string; name: string; reputation: number; tasksCompleted: number }[];

  const topCapabilities = db.prepare(`
    SELECT capability, COUNT(*) AS agentCount
    FROM agent_capabilities
    GROUP BY capability
    ORDER BY agentCount DESC, capability ASC
    LIMIT 8
  `).all() as { capability: string; agentCount: number }[];

  const activityByDay = db.prepare(`
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
  `).all() as { date: string; completed: number; failed: number }[];

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
      weeklyCompleted: weeklyTasks.completed,
      weeklyFailed: weeklyTasks.failed,
      weeklySuccessRate: Math.round(weeklySuccessRate * 1000) / 1000,
    },
    capabilities: capCount,
    payments: {
      totalUsdcTransacted: Math.round(txStats.usdc_transacted * 100) / 100,
      totalSolTransacted: Math.round(txStats.sol_transacted * 10000) / 10000,
      totalTxns: txStats.total,
      refundedTxns: txStats.refunded,
      weeklyUsdcTransacted: Math.round(weeklyTx.usdc * 100) / 100,
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
  usdcTransacted: number;
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
          COALESCE(SUM(amount_sol) FILTER (WHERE status = 'completed' AND currency = 'USDC'), 0) AS usdc
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
      COALESCE(tx.usdc,      0) AS usdcTransacted,
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
  topEarners: { agentId: string; name: string; totalEarnedUsdc: number }[];
  topWorkers: { agentId: string; name: string; tasksCompleted: number; successRate: number }[];
}

export function getAllTimeLeaders(): AllTimeLeaders {
  const db = getDb();

  const topEarners = db.prepare(`
    SELECT a.agent_id AS agentId, a.name,
      COALESCE(SUM(tx.amount_sol) FILTER (WHERE tx.status = 'completed' AND tx.currency = 'USDC'), 0)
        AS totalEarnedUsdc
    FROM agents a
    LEFT JOIN transactions tx ON tx.to_agent = a.agent_id
    GROUP BY a.agent_id
    ORDER BY totalEarnedUsdc DESC
    LIMIT 10
  `).all() as { agentId: string; name: string; totalEarnedUsdc: number }[];

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
