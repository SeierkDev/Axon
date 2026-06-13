import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

interface ErrorLogRow {
  error_id: string;
  ts: string;
  level: string;
  event: string;
  message: string;
  source: string | null;
  agent_id: string | null;
  task_id: string | null;
  trace_id: string | null;
  request_id: string | null;
  details: string | null;
  created_at: string;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const level = searchParams.get("level");
  const source = searchParams.get("source");
  const agentId = searchParams.get("agentId");
  const since = searchParams.get("since");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10) || 100, 500);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (level) { conditions.push("level = ?"); params.push(level); }
  if (source) { conditions.push("source = ?"); params.push(source); }
  if (agentId) { conditions.push("agent_id = ?"); params.push(agentId); }
  if (since) { conditions.push("ts >= ?"); params.push(since); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = getDb()
    .prepare(`SELECT * FROM error_log ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit) as ErrorLogRow[];

  const errors = rows.map((r) => ({
    errorId: r.error_id,
    ts: r.ts,
    level: r.level,
    event: r.event,
    message: r.message,
    source: r.source,
    agentId: r.agent_id,
    taskId: r.task_id,
    traceId: r.trace_id,
    requestId: r.request_id,
    details: r.details ? JSON.parse(r.details) : null,
  }));

  const summary = getDb()
    .prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE level = 'error') AS errors,
        COUNT(*) FILTER (WHERE level = 'warn')  AS warnings,
        COUNT(*) FILTER (WHERE ts >= datetime('now', '-1 hour'))  AS lastHour,
        COUNT(*) FILTER (WHERE ts >= datetime('now', '-24 hours')) AS lastDay
      FROM error_log
    `)
    .get() as { total: number; errors: number; warnings: number; lastHour: number; lastDay: number };

  return NextResponse.json({ summary, errors });
}

export async function DELETE(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const before = searchParams.get("before");

  if (!before) {
    return NextResponse.json({ error: "before param required (ISO timestamp)" }, { status: 400 });
  }

  const { changes } = getDb()
    .prepare("DELETE FROM error_log WHERE ts < ?")
    .run(before);

  return NextResponse.json({ deleted: changes });
}
