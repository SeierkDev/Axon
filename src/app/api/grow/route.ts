import { NextRequest, NextResponse } from "next/server";
import { getLatestGrowRun, getGrowRun, getGrowEvents } from "@/lib/grow";

export const dynamic = "force-dynamic";

// Public read for the live experiment page. Monetary figures — the wallet's budget,
// total spend, and per-hire amounts — are intentionally NOT exposed here. The
// experiment shows the flow and the verifiable receipts, not the balance.
// Safety net for any legacy summary that embedded an amount. The engine no longer
// writes amounts into summaries, so for current runs this is a no-op — it must never
// mangle clean text (e.g. spaces around em-dashes), so it only removes the amount
// token and the dangling "spent", then collapses the double-space that leaves.
const stripAmounts = (s: string) =>
  s
    .replace(/\s*\$?[\d,]+(?:\.\d+)?\s*USDC(\s+spent)?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+,/g, ",")
    .trim();

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("runId");
  const run = runId ? getGrowRun(runId) : getLatestGrowRun();
  if (!run) return NextResponse.json({ run: null, events: [] });

  // Explicit safe projection — never includes budgetUsdc.
  const runSafe = {
    runId: run.runId,
    agentId: run.agentId,
    mission: run.mission,
    status: run.status,
    plan: run.plan,
    deliverable: run.deliverable,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };

  const events = getGrowEvents(run.runId).map((e) => ({
    id: e.id,
    runId: e.runId,
    kind: e.kind,
    summary: stripAmounts(e.summary),
    taskId: e.taskId,
    toAgent: e.toAgent,
    createdAt: e.createdAt,
  }));

  return NextResponse.json({ run: runSafe, events });
}
