import { NextRequest, NextResponse } from "next/server";
import { getPublicReceipt } from "@/lib/receipts";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/receipts/[taskId]/public — the shareable receipt: metadata,
// tamper-evidence hashes and settlement only. No API key, no task content —
// the full receipt (content, output, webhooks, notes) stays on the authed
// GET /api/receipts/[taskId].
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`receipt-public:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { taskId } = await params;
  const receipt = getPublicReceipt(taskId);
  if (!receipt) return apiError("NOT_FOUND", `No receipt for task '${taskId}'`, 404);

  return NextResponse.json(receipt, {
    headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=30" },
  });
}
