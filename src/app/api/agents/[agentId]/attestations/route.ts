import { NextRequest, NextResponse } from "next/server";
import { createAttestation, getAttestationsForAgent, type AttestationErrorCode } from "@/lib/attestations";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { apiError, type ApiErrorCode } from "@/lib/apiError";
import { createAttestationSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

const ATTESTATION_ERROR: Record<AttestationErrorCode, { code: ApiErrorCode; status: number }> = {
  INVALID: { code: "VALIDATION_ERROR", status: 400 },
  NOT_FOUND: { code: "NOT_FOUND", status: 404 },
  DUPLICATE: { code: "CONFLICT", status: 409 },
  SIGNATURE: { code: "VALIDATION_ERROR", status: 400 },
  FORBIDDEN: { code: "FORBIDDEN", status: 403 },
};

// GET /api/agents/[agentId]/attestations — list an agent's attestations (public).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return NextResponse.json({ attestations: getAttestationsForAgent(agentId) });
}

// POST /api/agents/[agentId]/attestations — submit a signed attestation. The
// verifier's signature IS the authentication — no API key needed, so any wallet
// can act as a third-party verifier.
export async function POST(req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) {
  return withRequestContext(req, () => handlePost(req, ctx));
}

async function handlePost(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`attestations:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, createAttestationSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const result = createAttestation({
    agentId,
    capability: body.capability,
    verifier: body.verifier,
    signature: body.signature,
  });
  if (!result.success) {
    const mapped = ATTESTATION_ERROR[result.code];
    return apiError(mapped.code, result.error, mapped.status);
  }
  return NextResponse.json(result.attestation, { status: 201, headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
