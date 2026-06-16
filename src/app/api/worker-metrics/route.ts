import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)]);
}

export async function GET() {
  const db = getDb();

  const counts = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued') AS queued,
      COUNT(*) FILTER (WHERE status = 'running') AS running
    FROM tasks
  `).get() as { queued: number; running: number };

  const lastStarted = db.prepare(
    `SELECT started_at FROM tasks WHERE started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`
  ).get() as { started_at: string } | undefined;
  const lastSeenMs = lastStarted ? Date.now() - new Date(lastStarted.started_at).getTime() : null;

  const cutoffToday = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString();
  const cutoff24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const cutoff12h = new Date(Date.now() - 12 * 3_600_000).toISOString();

  const throughput = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE completed_at >= ?) AS today,
      COUNT(*) FILTER (WHERE completed_at >= ?) AS last24h
    FROM tasks WHERE status = 'completed'
  `).get(cutoffToday, cutoff24h) as { today: number; last24h: number };

  const rawByHour = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:00:00Z', completed_at) AS hour,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')    AS failed
    FROM tasks
    WHERE completed_at >= ?
    GROUP BY hour
    ORDER BY hour ASC
  `).all(cutoff12h) as { hour: string; completed: number; failed: number }[];

  // Fill gaps so every hour slot exists
  const byHour: { hour: string; completed: number; failed: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.now() - i * 3_600_000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:00:00Z`;
    const found = rawByHour.find((r) => r.hour === key);
    byHour.push(found ?? { hour: key, completed: 0, failed: 0 });
  }

  const processingRaw = (db.prepare(`
    SELECT ROUND((julianday(completed_at) - julianday(started_at)) * 86400000) AS ms
    FROM tasks
    WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
      AND completed_at >= started_at
      AND completed_at >= ?
    ORDER BY completed_at DESC LIMIT 200
  `).all(cutoff24h) as { ms: number }[]).map((r) => r.ms).sort((a, b) => a - b);

  const pickupRaw = (db.prepare(`
    SELECT ROUND((julianday(started_at) - julianday(created_at)) * 86400000) AS ms
    FROM tasks
    WHERE started_at IS NOT NULL
      AND started_at >= created_at
      AND started_at >= ?
    ORDER BY started_at DESC LIMIT 200
  `).all(cutoff24h) as { ms: number }[]).map((r) => r.ms).sort((a, b) => a - b);

  const perAgent = db.prepare(`
    SELECT
      t.to_agent                                                                            AS agentId,
      a.name,
      COUNT(*) FILTER (WHERE t.status = 'queued')                                          AS queued,
      COUNT(*) FILTER (WHERE t.status = 'running')                                         AS running,
      COUNT(*) FILTER (WHERE t.status = 'completed')                                       AS completedTotal,
      COUNT(*) FILTER (WHERE t.status = 'failed')                                          AS failedTotal,
      COUNT(*) FILTER (WHERE t.status = 'completed' AND date(t.completed_at) = date('now')) AS completedToday,
      ROUND(AVG(CASE WHEN t.status = 'completed' AND t.started_at IS NOT NULL AND t.completed_at IS NOT NULL
        THEN (julianday(t.completed_at) - julianday(t.started_at)) * 86400000 END))        AS avgProcessingMs
    FROM tasks t
    LEFT JOIN agents a ON a.agent_id = t.to_agent
    GROUP BY t.to_agent
    ORDER BY completedTotal DESC
  `).all() as {
    agentId: string; name: string | null; queued: number; running: number;
    completedTotal: number; failedTotal: number; completedToday: number; avgProcessingMs: number | null;
  }[];

  const recentTasks = db.prepare(`
    SELECT
      task_id, to_agent, status, created_at, started_at, completed_at,
      CASE WHEN started_at IS NOT NULL AND completed_at IS NOT NULL
        THEN ROUND((julianday(completed_at) - julianday(started_at)) * 86400000) END AS processingMs,
      CASE WHEN started_at IS NOT NULL
        THEN ROUND((julianday(started_at) - julianday(created_at)) * 86400000) END AS pickupMs
    FROM tasks
    ORDER BY created_at DESC LIMIT 20
  `).all();

  return NextResponse.json({
    worker: { queueDepth: counts.queued, running: counts.running, lastSeenMs },
    throughput: { today: throughput.today, last24h: throughput.last24h, byHour },
    latency: {
      p50ProcessingMs: percentile(processingRaw, 50),
      p95ProcessingMs: percentile(processingRaw, 95),
      avgPickupMs: pickupRaw.length > 0 ? Math.round(pickupRaw.reduce((a, b) => a + b, 0) / pickupRaw.length) : 0,
    },
    perAgent,
    recentTasks,
    updatedAt: new Date().toISOString(),
  });
}
