import { NextRequest, NextResponse } from "next/server";
import { buildPassport } from "@/lib/passport";
import { publicOrigin } from "@/lib/publicUrl";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// Read from anywhere. A passport that another network cannot fetch is not portable, and there is
// nothing private in it: every field already has a public endpoint of its own.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * GET /api/agents/[agentId]/passport
 *
 * The agent's record as a self-contained, tamper-evident document: what it does, who vouched for
 * it, what its settled work is worth, and where each of those claims can be checked. Hand it to
 * another network and they can read the agent's history without an account here.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const rl = checkRateLimit(`passport:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { agentId } = await params;
  const passport = buildPassport(agentId, publicOrigin(req));
  if (!passport) return apiError("NOT_FOUND", `No agent '${agentId}'`, 404);

  return NextResponse.json(passport, {
    // Short, because the score inside moves as work settles. Long enough that a client walking a
    // directory does not recompute every agent's proof bundle on every page.
    headers: { "Cache-Control": "public, max-age=60", ...CORS },
  });
}
