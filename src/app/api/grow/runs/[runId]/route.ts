import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { getGrowRun, getGrowEvents, getGrowSpent } from "@/lib/grow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/grow/runs/<runId> — one mission and its live timeline.
//
// Owner-scoped: somebody else's mission returns the same 404 as one that never
// existed, so this can't be used to discover what other people are running.
// The hires themselves stay publicly verifiable at /r/<taskId> — the receipts
// are the proof; this is the private view of the run that produced them.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const { runId } = await params;
  const run = getGrowRun(runId);
  if (!run || run.ownerWallet !== auth.user.walletAddress) {
    return apiError("NOT_FOUND", `Mission '${runId}' not found`, 404);
  }

  const events = getGrowEvents(runId);
  const spentUsdc = getGrowSpent(runId);
  return NextResponse.json({
    run,
    events,
    spentUsdc,
    remainingUsdc: Math.round((run.budgetUsdc - spentUsdc) * 10000) / 10000,
    hires: events.filter((e) => e.kind === "result").length,
    // Bought vs made in-house — the deliverable's provenance, not just its size.
    selfDone: events.filter((e) => e.kind === "self" && (e.data as { ok?: boolean } | undefined)?.ok === true).length,
  });
}
