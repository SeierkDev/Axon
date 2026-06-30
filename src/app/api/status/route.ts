import { NextRequest, NextResponse } from "next/server";
import { getSystemStatus } from "@/lib/status";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/status — public platform status: components, overall health, live
// metrics. Always returns 200 (the body carries the status). Rate-limited per IP;
// the heavy metrics query is memoized so a flood can't load the DB.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`status:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  return NextResponse.json(getSystemStatus(), {
    headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=10" },
  });
}
