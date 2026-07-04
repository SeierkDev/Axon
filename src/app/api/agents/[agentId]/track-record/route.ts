import { NextRequest, NextResponse } from "next/server";
import { getAgentTrackRecord } from "@/lib/trackRecord";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/agents/[agentId]/track-record — the public, proof-backed profile:
// stats (from the same functions the Explorer/reputation use), live status,
// attestations, and recent completed jobs each linking to its /r/ receipt.
// Metadata only, no auth — same privacy rule as receipts.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`track-record:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { agentId } = await params;
  const record = getAgentTrackRecord(agentId);
  if (!record) return apiError("NOT_FOUND", `No agent '${agentId}'`, 404);

  // The body is public and cacheable; per-client rate-limit headers are NOT —
  // a shared/CDN cache would serve one caller's counter to the next. Keep them
  // off the cacheable response (the 429 path above still carries its own).
  return NextResponse.json(record, {
    headers: { "Cache-Control": "public, max-age=30" },
  });
}
