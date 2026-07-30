import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { recordAuditEvent } from "@/lib/audit";
import { getGrowRun, setGrowRunPublished } from "@/lib/grow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/grow/runs/<runId>/publish — put a finished mission on a public page,
// or take it back down with { "published": false }.
//
// This is the only thing in Missions that makes CONTENT public: the brief and
// the result, in full. So it's the owner's explicit act, never a default, and it
// reverses. A mission still in flight can't be published — the page would show a
// half-built result that then changes under whoever is reading it.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const { runId } = await params;
    const body = (await req.json().catch(() => ({}))) as { published?: unknown };
    // Absent means publish — that's what POSTing to /publish asks for. Anything
    // else has to be exactly `true`. A loose `!== false` treats 0, null and the
    // string "false" as "publish", so a client trying to take a mission DOWN
    // would put it up. On something that exposes content, the ambiguous case has
    // to fail towards private.
    const publish = body.published === undefined || body.published === true;

    const existing = getGrowRun(runId);
    // Same shape as a miss for someone else's mission — don't confirm it exists.
    if (!existing || existing.ownerWallet !== auth.user.walletAddress) {
      return apiError("NOT_FOUND", `Mission '${runId}' not found`, 404);
    }
    if (existing.status !== "completed" && existing.status !== "failed") {
      return apiError(
        "CONFLICT",
        "A mission can only be published once it has finished — otherwise the page would change under its readers",
        409,
        { status: existing.status },
      );
    }

    const run = setGrowRunPublished(runId, auth.user.walletAddress, publish);
    if (!run) return apiError("CONFLICT", "Could not change this mission's visibility", 409);

    recordAuditEvent({
      req, actor: auth.user, action: publish ? "grow.mission_published" : "grow.mission_unpublished",
      resourceType: "grow_run", resourceId: runId,
      ownerAgentId: run.agentId, ownerWallet: auth.user.walletAddress,
    });

    return NextResponse.json({
      runId,
      published: run.published ?? false,
      publishedAt: run.publishedAt,
      url: run.published ? `/m/${runId}` : null,
    });
  });
}
