import { NextRequest, NextResponse } from "next/server";
import { getAgentActivity } from "@/lib/world";
import { getAgentById } from "@/lib/agents";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/world/agent/[agentId] — live activity for a house's storefront
// panel: what the agent is doing RIGHT NOW. Follows the explorer's privacy
// rule — statuses, counts, and timestamps only; never task content.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world-agent:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { agentId } = await params;
  if (!getAgentById(agentId)) {
    return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
  }

  return NextResponse.json(getAgentActivity(agentId), {
    headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=10" },
  });
}
