import { NextRequest, NextResponse } from "next/server";
import { getEpochSnapshot } from "@/lib/epochs";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/world/epoch — the current Axon World epoch: window, countdown, live
// activity totals and the non-monetary agent leaderboard. Read-only; no rewards.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world-epoch:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  return NextResponse.json(getEpochSnapshot(), {
    headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=30" },
  });
}
