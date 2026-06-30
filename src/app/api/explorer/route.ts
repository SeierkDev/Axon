import { NextRequest, NextResponse } from "next/server";
import { getExplorerFeed } from "@/lib/explorer";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/explorer — recent network activity + headline totals (public).
// Metadata only: agents, status, amounts, timestamps — never task content.
// Rate-limited per IP; the heavy totals query is memoized so a flood can't load the DB.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`explorer:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const raw = new URL(req.url).searchParams.get("limit");
  const limit = raw ? Number(raw) : undefined;
  return NextResponse.json(getExplorerFeed(limit), {
    headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=10" },
  });
}
