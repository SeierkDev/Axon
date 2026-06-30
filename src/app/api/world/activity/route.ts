import { NextRequest, NextResponse } from "next/server";
import { getWorldActivity } from "@/lib/world";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/world/activity — recent task completions for the world's live task
// streaks. Metadata only (ids, parties, timestamps) per the explorer privacy
// rule; never task content.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world-activity:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  return NextResponse.json({ events: getWorldActivity() }, {
    headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=5" },
  });
}
