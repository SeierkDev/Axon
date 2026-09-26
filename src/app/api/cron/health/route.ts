// POST /api/cron/health
// The five-minute housekeeping pass: failure-pattern watchdog, description backfill, WAL checkpoint.
// Railway cron: POST https://axon-agents.com/api/cron/health every 5 min.
//
// It no longer probes agent endpoints. The worker's health loop already does that on the same five
// minutes, so this route was a second sweep hitting every agent again, concurrently, for nothing.

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { failureReport } from "@/lib/failurePatterns";
import { logger } from "@/lib/logger";
import { noteCronRun } from "@/lib/cronRuns";
import { backfillDescriptions } from "@/lib/agentDescription";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Say something when one cause has taken over the failures, rather than waiting to be asked. */
function reportFailurePatterns(): void {
  try {
    const report = failureReport();
    if (!report.ok && report.alert) {
      logger.error("failures.systemic", report.alert, {
        windowHours: report.windowHours,
        failures: report.failures,
        top: report.patterns.slice(0, 3),
      });
    }
  } catch {
    /* never let the watchdog break the health pass it rides on */
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  noteCronRun("health");
  reportFailurePatterns();
  // A few descriptions per pass, for agents that predate them. Deliberately a trickle: there is no
  // reason to spend a hundred model calls in a burst when this runs every five minutes anyway.
  void backfillDescriptions(5).catch(() => {});
  const start = Date.now();

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
    durationMs: Date.now() - start,
    ...(walCheckpoint !== null ? { walCheckpoint } : {}),
  });
}
