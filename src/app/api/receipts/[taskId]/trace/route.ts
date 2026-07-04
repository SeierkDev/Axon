import { NextRequest, NextResponse } from "next/server";
import { getPublicTrace } from "@/lib/traceEvents";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/receipts/[taskId]/trace — the public, hash-chained execution trace
// behind a receipt's replayable timeline. Same privacy face as the public
// receipt: agents, hashes, and model/token/cost/latency metadata, plus a chain
// verification flag — never task content or output. No auth.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`receipt-trace:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { taskId } = await params;
  const trace = getPublicTrace(taskId);
  if (!trace) return apiError("NOT_FOUND", `No execution trace for task '${taskId}'`, 404);

  // The body is public and cacheable; per-client rate-limit headers are NOT —
  // a shared/CDN cache would serve one caller's counter to the next. A trace can
  // still be appended to while a task runs, so keep the TTL short.
  return NextResponse.json(trace, {
    headers: { "Cache-Control": "public, max-age=15" },
  });
}
