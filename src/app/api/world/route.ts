import { NextRequest, NextResponse } from "next/server";
import { getWorldSnapshot } from "@/lib/world";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/world — the Axon Open World city model derived from live network state
// (Phase 10). Metadata only: agent name, district, real metrics, and a stable
// world position per agent. Rate-limited per IP; the snapshot is memoized so a
// flood can't load the DB.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  return NextResponse.json(getWorldSnapshot(), {
    headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=15" },
  });
}
