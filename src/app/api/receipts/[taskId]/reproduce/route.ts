import { NextRequest, NextResponse } from "next/server";
import { getReproProof, reproduceTask, ReproError } from "@/lib/reproducibility";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// A re-run spends real model tokens, so triggering one is admin-gated. Reading a
// stored proof (GET) is public. When REPRODUCE_SECRET is unset the trigger is
// dev-only, never open in production.
function authorized(req: NextRequest): boolean {
  const secret = process.env.REPRODUCE_SECRET?.trim();
  // Fail closed: only open when explicitly in local development (NODE_ENV unset or
  // "production" in any deploy keeps the paid endpoint locked).
  if (!secret) return process.env.NODE_ENV === "development";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

// GET /api/receipts/[taskId]/reproduce — the public reproducibility proof: output
// hashes, verdict, similarity, and the published method. Same privacy face as the
// receipt — never the output text. Null → 404.
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const rl = checkRateLimit(`receipt-reproduce:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { taskId } = await params;
  const proof = getReproProof(taskId);
  if (!proof) return apiError("NOT_FOUND", `No reproducibility proof for task '${taskId}'`, 404);

  return NextResponse.json(proof, { headers: { "Cache-Control": "public, max-age=30" } });
}

// POST /api/receipts/[taskId]/reproduce — re-run the task deterministically and
// (re)generate its proof. Admin-gated: it costs model tokens.
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  if (!authorized(req)) return apiError("AUTH_REQUIRED", "reproduce requires authorization", 401);

  const { taskId } = await params;
  try {
    const proof = await reproduceTask(taskId);
    return NextResponse.json(proof);
  } catch (e) {
    // Client-side conditions (bad/incomplete task, not reproducible) carry a typed
    // status; everything else is a genuine upstream failure.
    if (e instanceof ReproError) {
      return apiError(e.status === 404 ? "NOT_FOUND" : "NOT_SUPPORTED", e.message, e.status);
    }
    return apiError("UPSTREAM_ERROR", e instanceof Error ? e.message : "reproduce failed", 502);
  }
}
