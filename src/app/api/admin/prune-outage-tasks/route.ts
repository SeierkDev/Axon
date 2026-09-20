import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { pruneOutageTasks } from "@/lib/pruneOutageTasks";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// POST /api/admin/prune-outage-tasks
//
// Removes the tasks that failed because the platform's own provider key was rejected, which one
// misconfiguration wrote into the ledger several thousand times. The database lives on a volume
// this process is the only thing with a handle on, so the operation has to be reachable here
// rather than over a shell.
//
// Dry run unless `apply=true` is passed, and the report it returns is the same either way, so the
// scope can be read before anything is removed. Behind CRON_SECRET, like the other admin routes.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apply = req.nextUrl.searchParams.get("apply") === "true";
  const report = pruneOutageTasks(getDb(), { apply });

  if (report.applied) {
    logger.warn("admin.pruned_outage_tasks", "Removed tasks that failed on the provider key outage", {
      removedTasks: report.removedTasks,
      removedRelated: report.removedRelated,
      failedAfter: report.failedAfter,
    });
  }

  return NextResponse.json(report);
}
