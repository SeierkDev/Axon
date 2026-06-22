import { getDb } from "./db";
import { syncToTurso } from "./db-turso";

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
  staleDays: number | null;  // days since last completed task (null if none yet)
  decayFactor: number;       // 0–1 staleness multiplier applied to reputation
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

// Reputation decay for stale agents (Phase 6: Marketplace Trust Layer).
// A great score earned months ago is a weaker signal than recent activity, so
// reputation decays with time since the agent's last completed task: full score
// within a grace window, then sliding down to a floor over the following span.
const DECAY_GRACE_DAYS = 30;  // no decay within this window of the last task
const DECAY_SPAN_DAYS = 90;   // decays to the floor over this span after grace
const DECAY_FLOOR = 0.6;      // a fully stale agent retains 60% of its score

function stalenessDecay(daysSinceLastTask: number): number {
  if (daysSinceLastTask <= DECAY_GRACE_DAYS) return 1;
  if (daysSinceLastTask >= DECAY_GRACE_DAYS + DECAY_SPAN_DAYS) return DECAY_FLOOR;
  const t = (daysSinceLastTask - DECAY_GRACE_DAYS) / DECAY_SPAN_DAYS;
  return 1 - (1 - DECAY_FLOOR) * t;
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

  // Staleness decay: based on time since the agent's last completed task.
  // Agents with no completed tasks have nothing to decay (factor 1).
  const lastRow = db.prepare(`
    SELECT MAX(completed_at) AS last_completed
    FROM tasks
    WHERE to_agent = ?
      AND status = 'completed'
      AND completed_at IS NOT NULL
  `).get(agentId) as { last_completed: string | null };

  let staleDays: number | null = null;
  let decayFactor = 1;
  if (lastRow.last_completed) {
    const ms = Date.now() - new Date(lastRow.last_completed).getTime();
    staleDays = Math.max(0, Math.floor(ms / 86_400_000));
    decayFactor = stalenessDecay(staleDays);
  }

  const reputation = Math.round(score * decayFactor * 10) / 10;

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
    staleDays,
    decayFactor: Math.round(decayFactor * 1000) / 1000,
    lastUpdated: now,
  };
}

export function updateAgentReputation(agentId: string): number {
  const metrics = computeReputation(agentId);
  getDb()
    .prepare("UPDATE agents SET reputation = ? WHERE agent_id = ?")
    .run(metrics.reputation, agentId);
  void syncToTurso();
  return metrics.reputation;
}

// Recompute and persist reputation for every agent. Run periodically (daily cron)
// so staleness decay materializes in the cached `agents.reputation` column that
// discovery ranks by. Without this, an idle agent is never recomputed
// (updateAgentReputation only fires on task completion), so its decay would never
// affect its ranking — defeating the purpose. Returns the number of agents updated.
export function recomputeAllReputations(): number {
  const db = getDb();
  const ids = db.prepare("SELECT agent_id FROM agents").all() as { agent_id: string }[];
  const update = db.prepare("UPDATE agents SET reputation = ? WHERE agent_id = ?");
  const apply = db.transaction((rows: { agent_id: string }[]) => {
    for (const { agent_id } of rows) {
      update.run(computeReputation(agent_id).reputation, agent_id);
    }
  });
  apply(ids);
  void syncToTurso();
  return ids.length;
}
