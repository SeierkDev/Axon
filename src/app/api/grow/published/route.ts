import { NextRequest, NextResponse } from "next/server";
import { listPublishedGrowRuns, getGrowEvents } from "@/lib/grow";
import { toPublicMissionCard } from "@/lib/missionPublic";

export const runtime = "nodejs";

// GET /api/grow/published — the gallery: missions their owners chose to show.
//
// Cards only. The brief is here because it's what makes a card worth clicking;
// the deliverable and the steps are not, so listing the gallery never bulk-serves
// the contents of everybody's results.
export async function GET(req: NextRequest) {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 12, 1), 50);
  return NextResponse.json(
    { missions: listPublishedGrowRuns(limit).map((r) => toPublicMissionCard(r, getGrowEvents(r.runId))) },
    // Not cached. Taking a mission down is a promise the owner is given in
    // those words, and a shared 60-second cache kept serving the brief — and a
    // card linking to a page that now 404s — after they'd taken it back. The
    // query costs ~13ms for a full 50 cards, so the cache was buying very
    // little against that.
    { headers: { "Cache-Control": "no-store" } },
  );
}
