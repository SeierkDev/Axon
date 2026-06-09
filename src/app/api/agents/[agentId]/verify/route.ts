// GET /api/agents/:agentId/verify
// Triggers an immediate x402 compliance probe on the agent's registered endpoint.
// Returns the verification result and updates verification_status on the agent.

import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { verifyAgentEndpoint } from "@/lib/verification";
import { requireAgentOwner } from "@/lib/apiAuth";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";

type Params = { params: Promise<{ agentId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { agentId } = await params;

  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const agent = getAgentById(agentId);
  if (!agent) {
    return apiError("NOT_FOUND", "Agent not found", 404);
  }

  const ip = getClientIp(req);
  const rl = checkRateLimit(`agent-verify:${ip}:${agentId}`, 5, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  if (!agent.endpoint) {
    return apiError("VALIDATION_ERROR", "Agent has no registered endpoint to verify", 400);
  }

  const result = await verifyAgentEndpoint(agentId, agent.endpoint);
  return NextResponse.json({ result });
}
