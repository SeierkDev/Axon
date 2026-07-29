import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { recordAuditEvent } from "@/lib/audit";
import { cancelGrowRun, getGrowRun, recordGrowEvent } from "@/lib/grow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/grow/runs/<runId>/cancel — call a mission off.
//
// Cooperative, not a hard kill. The runner checks between steps, so a stop can
// never land in the middle of a hire — money that has already moved is always
// recorded, and work already paid for is still assembled rather than thrown
// away. The run keeps going only as far as the current step.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const { runId } = await params;
    const existing = getGrowRun(runId);
    // Same shape as a miss for someone else's mission — don't confirm it exists.
    if (!existing || existing.ownerWallet !== auth.user.walletAddress) {
      return apiError("NOT_FOUND", `Mission '${runId}' not found`, 404);
    }

    const run = cancelGrowRun(runId, auth.user.walletAddress);
    if (!run) {
      return apiError("CONFLICT", `Mission is already '${existing.status}' — nothing to stop`, 409);
    }

    recordGrowEvent(runId, { kind: "note", summary: "Owner asked to stop — finishing the current step." });
    recordAuditEvent({
      req, actor: auth.user, action: "grow.mission_canceled",
      resourceType: "grow_run", resourceId: runId,
      ownerAgentId: run.agentId, ownerWallet: auth.user.walletAddress,
    });

    return NextResponse.json({ runId, canceled: true, status: run.status });
  });
}
