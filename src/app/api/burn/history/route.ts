import { NextRequest, NextResponse } from "next/server";
import { burnPage, storedBurnRange, backfillOlderBurns } from "@/lib/burnHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/burn/history?before=<n>&limit=<n>
//
// A page of the burn archive, newest first. The page used to show ten and stop, over a heading that said
// "every burn", while eighty three had happened. A receipt nobody can reach is not a receipt.
//
// When a page runs out, this walks back through older blocks for burns that were never written down,
// which is how the earliest ones are recovered: this pot fired eleven times before anything was
// recording them. That walk happens because somebody paged back far enough to need it, not on a timer.
export async function GET(req: NextRequest) {
  const before = Number(req.nextUrl.searchParams.get("before"));
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 20, 1), 50);

  let page = burnPage(limit, Number.isFinite(before) && before > 0 ? before : undefined);

  // Nothing left in the table, but the chain may still be holding older ones.
  if (!page.hasMore && storedBurnRange().lowest !== 1) {
    const { added } = await backfillOlderBurns();
    if (added > 0) {
      page = burnPage(limit, Number.isFinite(before) && before > 0 ? before : undefined);
    }
  }

  const range = storedBurnRange();
  return NextResponse.json(
    { ...page, oldestStored: range.lowest, storedCount: range.count },
    { headers: { "Cache-Control": "no-store" } },
  );
}
