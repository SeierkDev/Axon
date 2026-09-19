import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { consumeChallenge, verifySignature } from "@/lib/identity";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";

interface VerifyBody {
  agentId: string;
  challenge: string;
  signature: string; // 0x-prefixed EIP-191 personal_sign signature of the challenge
}

// POST /api/agents/verify — verify an agent's identity
// Flow: GET /api/agents/[agentId]/challenge → sign challenge → POST here
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`agent-verify-signature:${ip}`, 20, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const body = await req.json().catch(() => null) as VerifyBody | null;
  if (!body || typeof body !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  if (!body.agentId || !body.challenge || !body.signature) {
    return apiError("VALIDATION_ERROR", "agentId, challenge, and signature are required", 400);
  }

  const agent = getAgentById(body.agentId);
  if (!agent) {
    return apiError("NOT_FOUND", `Agent '${body.agentId}' not found`, 404);
  }

  // Recover the signer from the signature and check it is the agent's registered key
  const verified = await verifySignature({
    address: agent.publicKey,
    message: body.challenge,
    signature: body.signature,
  });

  if (!verified) {
    return apiError("AUTH_REQUIRED", "Signature verification failed", 401);
  }

  // Consume only after the signature is valid so attackers cannot burn challenges.
  const validChallenge = consumeChallenge(body.agentId, body.challenge);
  if (!validChallenge) {
    return apiError(
      "AUTH_REQUIRED",
      "Challenge is invalid or expired. Request a new one from /api/agents/[agentId]/challenge",
      401
    );
  }

  return NextResponse.json({ agentId: body.agentId, verified: true });
}
