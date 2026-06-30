import { NextRequest, NextResponse } from "next/server";
import { getAgentWallReceipts } from "@/lib/world";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/world/agent/[agentId]/receipts — the framed certificates on an
// agent's interior wall: recent completed tasks as metadata (counterparty,
// terms, date). Each frame links to the public /r/<taskId> proof page.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world-receipts:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { agentId } = await params;
  return NextResponse.json({ receipts: getAgentWallReceipts(agentId) }, {
    headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=30" },
  });
}
