import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { getBearerToken } from "@/lib/identity";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { getGrowRun, getGrowEvents } from "@/lib/grow";
import { buildGrowDeps } from "@/lib/growWiring";
import { resumeGrowMission } from "@/lib/growRunner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A run this stale has certainly lost its process — nothing is still working on it. */
const STRANDED_AFTER_MS = 10 * 60 * 1000;

// POST /api/grow/runs/<runId>/resume — finish a mission that died mid-flight.
//
// A deploy or a crash leaves a run non-terminal forever: the hires it already
// paid for are orphaned and no deliverable is ever assembled, so the owner paid
// and got nothing. This re-gathers the work that was bought and assembles it.
//
// It never hires anything new. Recovering value is one thing; spending more of
// somebody's money because their server restarted is another.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const { runId } = await params;
    const run = getGrowRun(runId);
    // Same shape as a miss for someone else's mission — don't confirm it exists.
    if (!run || run.ownerWallet !== auth.user.walletAddress) {
      return apiError("NOT_FOUND", `Mission '${runId}' not found`, 404);
    }
    if (run.status === "completed" || run.status === "failed") {
      return apiError("CONFLICT", `Mission is already '${run.status}'`, 409);
    }

    // Only resume what is genuinely abandoned. Resuming a mission that is still
    // running would synthesize from a half-finished set of results while the
    // original process carries on hiring — two writers on one run.
    const events = getGrowEvents(runId);
    const lastAt = Date.parse(events.at(-1)?.createdAt ?? run.startedAt);
    if (Number.isFinite(lastAt) && Date.now() - lastAt < STRANDED_AFTER_MS) {
      return apiError(
        "CONFLICT",
        "This mission is still working — give it a few minutes before resuming, or stop it first",
        409,
        { lastActivityAt: new Date(lastAt).toISOString() },
      );
    }

    const apiKey = getBearerToken(req);
    if (!apiKey) return apiError("AUTH_REQUIRED", "Missing API key", 401);
    const deps = buildGrowDeps({ self: run.agentId, apiKey });

    try {
      const result = await resumeGrowMission(deps, runId);
      if (!result) return apiError("CONFLICT", "Nothing to resume", 409);
      return NextResponse.json({
        runId,
        status: result.run.status,
        recovered: result.hires,
        spentUsdc: result.spentUsdc,
        deliverable: result.deliverable,
      });
    } catch (err) {
      return apiError(
        "UPSTREAM_ERROR",
        `Could not finish the mission — ${err instanceof Error ? err.message : "the agent's model did not respond"}`,
        502,
      );
    }
  });
}
