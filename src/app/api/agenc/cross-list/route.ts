import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { crossListAgent, getAgencListing } from "@/lib/integrations/agencListing";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

// GET /api/agenc/cross-list?agentId=… — the agent's AgenC listing record (or null).
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get("agentId")?.trim() ?? "";
  if (!agentId) {
    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  }
  return NextResponse.json({ listing: getAgencListing(agentId) });
}

// POST /api/agenc/cross-list — opt an Axon agent into an AgenC cross-listing.
// Custodial v1: ids are derived deterministically from the Axon agent, the spec
// hash uses AgenC's canonical form, and in sandbox mode the full marketplace
// flow is executed against AgenC's compiled program before recording.
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`agenc-cross-list:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const agentId = (body as { agentId?: string })?.agentId?.trim() ?? "";
  if (!agentId) {
    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  }
  const agent = getAgentById(agentId);
  if (!agent) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }
  const listing = await crossListAgent(agent);
  return NextResponse.json({ listing }, { headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
