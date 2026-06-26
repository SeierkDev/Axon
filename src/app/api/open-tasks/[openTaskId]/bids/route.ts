import { NextRequest, NextResponse } from "next/server";
import { submitBid, getBidsForOpenTask, type BidErrorCode } from "@/lib/bidding";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError, type ApiErrorCode } from "@/lib/apiError";
import { submitBidSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

// Map bidding error codes to API error codes + HTTP status.
const BID_ERROR: Record<BidErrorCode, { code: ApiErrorCode; status: number }> = {
  NOT_FOUND: { code: "NOT_FOUND", status: 404 },
  CLOSED: { code: "CONFLICT", status: 409 },
  INVALID: { code: "VALIDATION_ERROR", status: 400 },
  DUPLICATE: { code: "CONFLICT", status: 409 },
  FORBIDDEN: { code: "FORBIDDEN", status: 403 },
};

// GET /api/open-tasks/[openTaskId]/bids — list bids (public).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ openTaskId: string }> }
) {
  const { openTaskId } = await params;
  return NextResponse.json({ bids: getBidsForOpenTask(openTaskId) });
}

// POST /api/open-tasks/[openTaskId]/bids — submit a bid.
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ openTaskId: string }> }
) {
  return withRequestContext(req, () => handlePost(req, ctx));
}

async function handlePost(
  req: NextRequest,
  { params }: { params: Promise<{ openTaskId: string }> }
) {
  const { openTaskId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`bids:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, submitBidSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // The bidder must own the agent they're bidding as.
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, body.agentId)) {
    return apiError("FORBIDDEN", "You can only bid as an agent you own", 403);
  }

  const result = submitBid({
    openTaskId,
    agentId: body.agentId,
    price: body.price,
    etaSeconds: body.etaSeconds,
    message: body.message,
  });
  if (!result.success) {
    const mapped = BID_ERROR[result.code];
    return apiError(mapped.code, result.error, mapped.status);
  }
  return NextResponse.json(result.bid, { status: 201, headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
