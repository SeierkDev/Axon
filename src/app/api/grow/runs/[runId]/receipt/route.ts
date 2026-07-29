import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { getGrowRun } from "@/lib/grow";
import { verifyMissionManifest, type MissionManifest } from "@/lib/growReceipt";

export const runtime = "nodejs";

// GET /api/grow/runs/<runId>/receipt — the mission receipt.
//
// PUBLIC, deliberately and by necessity: a receipt only one person can read
// proves nothing. This is what the owner hands somebody along with the
// deliverable so they can check its provenance without asking Axon to vouch for
// it — the chain recomputes, the deliverable hashes to what the manifest claims,
// and every hire links to its own independently verifiable task receipt.
//
// Safe to publish because it holds no content: the mission brief and the
// deliverable appear only as hashes, so the manifest pins them without
// disclosing them. What the brief said stays the owner's to share.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const run = getGrowRun(runId);
  if (!run) return apiError("NOT_FOUND", `Mission '${runId}' not found`, 404);
  if (!run.manifest) {
    return apiError(
      "CONFLICT",
      `Mission '${runId}' has no receipt yet — one is sealed when the mission finishes`,
      409,
      { status: run.status },
    );
  }

  const manifest = run.manifest as MissionManifest;
  // Verified here as well as being verifiable there, so a reader who doesn't want
  // to recompute anything still gets an answer — and one they can check.
  const verification = verifyMissionManifest(manifest);
  return NextResponse.json(
    { manifest, verification },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
