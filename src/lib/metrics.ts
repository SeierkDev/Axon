import { getDb } from "./db";

export interface AgentMetrics {
  agentId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  avgLatencyMs: number | null;
  uptimePct: number | null;
  windowDays: number;
}

export function recordTaskLatency(
  agentId: string,
  latencyMs: number,
  success: boolean
): void {
  const today = new Date().toISOString().slice(0, 10);
  const db = getDb();

  db.prepare(`
    INSERT INTO agent_metrics (agent_id, window_start, total_tasks, completed, failed, total_latency_ms)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(agent_id, window_start) DO UPDATE SET
      total_tasks      = total_tasks + 1,
      completed        = completed + excluded.completed,
      failed           = failed + excluded.failed,
      total_latency_ms = total_latency_ms + excluded.total_latency_ms
  `).run(
    agentId,
    today,
    success ? 1 : 0,
    success ? 0 : 1,
    latencyMs,
  );
}

export function getAgentMetrics(agentId: string, days = 30): AgentMetrics {
  const db = getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(total_tasks), 0)      AS total_tasks,
      COALESCE(SUM(completed), 0)        AS completed,
      COALESCE(SUM(failed), 0)           AS failed,
      COALESCE(SUM(total_latency_ms), 0) AS total_latency_ms
    FROM agent_metrics
    WHERE agent_id = ? AND window_start >= ?
  `).get(agentId, since) as {
    total_tasks: number;
    completed: number;
    failed: number;
    total_latency_ms: number;
  };

  const finished = row.completed + row.failed;

  return {
    agentId,
    totalTasks: row.total_tasks,
    completedTasks: row.completed,
    failedTasks: row.failed,
    avgLatencyMs: row.total_tasks > 0
      ? Math.round(row.total_latency_ms / row.total_tasks)
      : null,
    uptimePct: finished > 0
      ? Math.round((row.completed / finished) * 1000) / 10
      : null,
    windowDays: days,
  };
}
