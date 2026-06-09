// POST /api/cron/health
// Pings all agents that have a registered endpoint and updates their verification_status.
// Railway cron: POST https://axon-agents.com/api/cron/health every 5 min.

import { NextRequest, NextResponse } from "next/server";
import { getAllAgents } from "@/lib/agents";
import { verifyAgentEndpoint } from "@/lib/verification";
import { getDb } from "@/lib/db";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const agents = getAllAgents().filter((a) => a.endpoint);
  const start = Date.now();

  const results = await Promise.allSettled(
    agents.map((a) => verifyAgentEndpoint(a.agentId, a.endpoint!))
  );

  const summary = results.map((r, i) => ({
    agentId: agents[i].agentId,
    status: r.status === "fulfilled" ? r.value.status : "error",
    latencyMs: r.status === "fulfilled" ? r.value.latencyMs : null,
  }));

  // Checkpoint the WAL file so it doesn't grow unbounded between Railway deploys.
  // TRUNCATE mode resets the WAL to zero bytes after the checkpoint completes.
  // pragma(..., { simple: false }) always returns an array of row objects.
  let walCheckpoint: { busy: number; log: number; checkpointed: number } | null = null;
  try {
    const rows = getDb().pragma("wal_checkpoint(TRUNCATE)", { simple: false }) as
      { busy: number; log: number; checkpointed: number }[];
    walCheckpoint = rows[0] ?? null;
  } catch {
    // Non-fatal: SQLite may be in rollback journal mode or not using WAL
  }

  return NextResponse.json({
    ok: true,
    checked: agents.length,
    durationMs: Date.now() - start,
    results: summary,
    ...(walCheckpoint !== null ? { walCheckpoint } : {}),
  });
}
