import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { getPublishedGrowRun, getGrowEvents } from "@/lib/grow";
import { toPublicMission } from "@/lib/missionPublic";

export const runtime = "nodejs";

// GET /api/grow/runs/<runId>/public — a published mission.
//
// No auth: the owner published it so it could be read. Anything not published
// answers exactly as a run that doesn't exist, so an id can't be probed to find
// out whether a private mission is behind it.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const run = getPublishedGrowRun(runId);
  if (!run) return apiError("NOT_FOUND", `Mission '${runId}' not found`, 404);

  // Not cached, for the same reason as the gallery list — more so here, since
  // this carries the whole deliverable rather than a card. "You can take it
  // down again" has to mean immediately, and a shared cache kept the result
  // readable for a minute after the owner took it back.
  return NextResponse.json(toPublicMission(run, getGrowEvents(runId)), {
    headers: { "Cache-Control": "no-store" },
  });
}
