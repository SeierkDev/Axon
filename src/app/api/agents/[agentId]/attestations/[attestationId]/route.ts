import { NextRequest, NextResponse } from "next/server";
import { revokeAttestation } from "@/lib/attestations";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";
import { revokeAttestationSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

// DELETE /api/agents/[agentId]/attestations/[attestationId] — revoke. Only the
// original verifier can, proven by a signature over the revocation message.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ agentId: string; attestationId: string }> }) {
  return withRequestContext(req, () => handleDelete(req, ctx));
}

async function handleDelete(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; attestationId: string }> }
) {
  const { attestationId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`attestations-revoke:${ip}`, 20, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, revokeAttestationSchema);
  if (!parsed.ok) return parsed.response;

  const result = revokeAttestation(attestationId, parsed.data.signature);
  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 400;
    const code = result.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR";
    return apiError(code, result.error, status);
  }
  return NextResponse.json({ revoked: true, attestationId });
}
