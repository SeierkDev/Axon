import { NextRequest, NextResponse } from "next/server";
import { getSpendSummary, averageFreeCallCostUsd } from "@/lib/spendSummary";

export const runtime = "nodejs";

// GET /api/admin/spend-summary?hours=24
//
// What inference has actually cost over a window, split into the hire somebody paid for and the
// hire nobody did. The second is the only one that costs the project anything, and it is the figure
// a free-call allowance has to be priced against: an allowance of N calls costs roughly N times
// `freeCallCostUsd`, per holder, with no revenue behind it.
//
// Admin-gated on the same secret the crons use. The tokens and costs are already recorded per step
// in trace_events and public receipts do not carry them; this only adds them up, and what a network
// pays its model provider is its own business rather than a fact about any agent.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = Number(req.nextUrl.searchParams.get("hours") ?? 24);
  // A silly window should answer for a sane one rather than refuse: this is a diagnostic, and the
  // clamp is visible in the response because `hours` is echoed back.
  const hours = Number.isFinite(raw) ? Math.min(24 * 30, Math.max(1, Math.floor(raw))) : 24;

  const summary = getSpendSummary(hours);

  return NextResponse.json({
    ...summary,
    /** Null when there is nothing to average. Never zero — zero would read as "free calls are free". */
    freeCallCostUsd: averageFreeCallCostUsd(hours),
  });
}
