import { NextRequest, NextResponse } from "next/server";
import { getBurnLive } from "@/lib/burnLive";
import { getBurnStats } from "@/lib/burn";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

// GET /api/burn — the live state of the burn pot: the schedule, what is waiting, and what has
// burned so far. Read-only. Cached for 10s: the page counts down from `readAt` in the browser, so
// a slightly stale read still shows a correct clock, and the node is not hit once per viewer.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`burn:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const [live, ledger] = await Promise.all([getBurnLive(), getBurnStats()]);

  return NextResponse.json(
    { ...live, forwarded: { totalEth: ledger.totalForwardedEth, pendingEth: ledger.pendingEth } },
    {
      headers: {
        ...rateLimitHeaders(rl, RATE_LIMIT),
        "Cache-Control": "public, max-age=10, stale-while-revalidate=30",
      },
    },
  );
}
