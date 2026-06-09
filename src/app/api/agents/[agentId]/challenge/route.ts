import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { createChallenge } from "@/lib/identity";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";

// GET /api/agents/[agentId]/challenge — issue a one-time challenge for identity proof
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`agent-challenge:${ip}:${agentId}`, 20, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  if (!getAgentById(agentId)) {
    return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
  }

  const challenge = createChallenge(agentId);

  return NextResponse.json({
    agentId,
    challenge,
    expiresInSeconds: 300,
    instruction: "Sign the challenge string with your agent's private key and POST to /api/agents/verify",
  });
}
