import { getDb } from "./db";

export interface ReputationMetrics {
  agentId: string;
  reputation: number;        // 0–10
  successRate: number;       // 0–1
  avgResponseTimeSec: number;
  responseTimeScore: number; // 0–1, lower time = higher score
  paymentReliability: number; // 0–1
  totalTasksCompleted: number;
  totalTasksFailed: number;
  totalTasks: number;
  lastUpdated: string;
}

// Normalize avg response time to a 0–1 score.
// < 5 s → 1.0, > 120 s → 0.0, linear in between.
const RESPONSE_FAST_SEC = 5;
const RESPONSE_SLOW_SEC = 120;

function responseTimeScore(avgSec: number): number {
  if (avgSec <= RESPONSE_FAST_SEC) return 1;
  if (avgSec >= RESPONSE_SLOW_SEC) return 0;
  return (RESPONSE_SLOW_SEC - avgSec) / (RESPONSE_SLOW_SEC - RESPONSE_FAST_SEC);
}

export function computeReputation(agentId: string): ReputationMetrics {
  const db = getDb();
  const now = new Date().toISOString();

  // Completed and failed task counts (as recipient)
  const counts = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')    AS failed
    FROM tasks
    WHERE to_agent = ?
      AND status IN ('completed', 'failed')
  `).get(agentId) as { completed: number; failed: number };

  const totalCompleted = counts.completed ?? 0;
  const totalFailed = counts.failed ?? 0;
  const totalTasks = totalCompleted + totalFailed;

  const successRate = totalTasks > 0 ? totalCompleted / totalTasks : 0;

  // Avg response time in seconds for completed tasks
  const responseRow = db.prepare(`
    SELECT AVG(
      (JULIANDAY(completed_at) - JULIANDAY(started_at)) * 86400
    ) AS avg_sec
    FROM tasks
    WHERE to_agent = ?
      AND status = 'completed'
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
  `).get(agentId) as { avg_sec: number | null };

  // null means no completed tasks with timing data — score 0, not 1
  const avgSec = responseRow.avg_sec ?? null;
  const rtScore = avgSec !== null ? responseTimeScore(avgSec) : 0;

  // Payment reliability: paid-completed / (paid-completed + paid-failed)
  const paidCounts = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE t.status = 'completed') AS paid_completed,
      COUNT(*) FILTER (WHERE t.status = 'failed')    AS paid_failed
    FROM tasks t
    INNER JOIN transactions tx ON tx.task_id = t.task_id
    WHERE t.to_agent = ?
      AND t.status IN ('completed', 'failed')
  `).get(agentId) as { paid_completed: number; paid_failed: number };

  const paidCompleted = paidCounts.paid_completed ?? 0;
  const paidFailed = paidCounts.paid_failed ?? 0;
  const paidTotal = paidCompleted + paidFailed;

  // Fall back to success rate if agent has no paid tasks yet
  const paymentReliability = paidTotal > 0
    ? paidCompleted / paidTotal
    : successRate;

  // Review score: avg star rating (1–5) normalized to 0–1, 0 if no reviews
  const reviewRow = db.prepare(`
    SELECT AVG(rating) AS avg_rating
    FROM reviews
    WHERE agent_id = ?
  `).get(agentId) as { avg_rating: number | null };
  const reviewScore = reviewRow.avg_rating !== null
    ? (reviewRow.avg_rating - 1) / 4
    : 0;

  // Weighted score → 0–10
  // success 45% | latency 20% | payment reliability 20% | reviews 15%
  const score = (
    successRate       * 0.45 +
    rtScore           * 0.20 +
    paymentReliability * 0.20 +
    reviewScore       * 0.15
  ) * 10;
  const reputation = Math.round(score * 10) / 10;

  return {
    agentId,
    reputation,
    successRate,
    avgResponseTimeSec: avgSec !== null ? Math.round(avgSec * 1000) / 1000 : 0,
    responseTimeScore: Math.round(rtScore * 1000) / 1000,
    paymentReliability,
    totalTasksCompleted: totalCompleted,
    totalTasksFailed: totalFailed,
    totalTasks,
    lastUpdated: now,
  };
}

export function updateAgentReputation(agentId: string): number {
  const metrics = computeReputation(agentId);
  getDb()
    .prepare("UPDATE agents SET reputation = ? WHERE agent_id = ?")
    .run(metrics.reputation, agentId);
  return metrics.reputation;
}
