// POST /api/cron/retention
// Purges old rows from webhook_deliveries, audit_events, agent_metrics,
// spend_alerts, telegram_posts, error_log, rate_limit_windows, and task_progress.
// Railway cron: POST https://axon-agents.com/api/cron/retention once daily.

import { NextRequest, NextResponse } from "next/server";
import { runRetentionCleanup } from "@/lib/retention";
import { recomputeAllReputations } from "@/lib/reputation";
import { recomputeAllProofScores } from "@/lib/proofScore";
import { pruneEndpointChecks } from "@/lib/endpointUptime";
import { logger } from "@/lib/logger";
import { noteCronRun, pruneCronRuns } from "@/lib/cronRuns";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  noteCronRun("retention");

  try {
    const start = Date.now();
    const deleted = runRetentionCleanup();
    // Recompute reputations daily so staleness decay reaches idle agents' cached
    // scores (discovery ranks by the column, which is otherwise only updated on
    // task completion).
    const reputationsRecomputed = recomputeAllReputations();
    // Refresh the cached Proof Score column the same way (list views badge by it).
    const proofScoresRecomputed = recomputeAllProofScores();
    // Keep the endpoint uptime history bounded (drop observations older than 30 days).
    const endpointChecksPruned = pruneEndpointChecks();
    // The job ledger is bounded here too, for the same reason: it is written on every cron tick, and
    // the every-five-minute jobs alone would put a hundred thousand rows a year into it.
    const cronRunsPruned = pruneCronRuns();
    logger.info("cron.retention_complete", "Retention cleanup complete", {
      ...deleted,
      reputationsRecomputed,
      proofScoresRecomputed,
      endpointChecksPruned,
      cronRunsPruned,
    });
    return NextResponse.json({ ok: true, deleted, reputationsRecomputed, proofScoresRecomputed, endpointChecksPruned, cronRunsPruned, durationMs: Date.now() - start });
  } catch (err) {
    logger.error("cron.retention_failed", "Retention cleanup failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Retention cleanup failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
