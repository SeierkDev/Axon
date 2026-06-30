import { NextRequest, NextResponse } from "next/server";
import { fileReport, listReports, type AbuseErrorCode, type AbuseStatus } from "@/lib/abuse";
import { isModerator } from "@/lib/moderation";
import { requireApiKey } from "@/lib/apiAuth";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { apiError, type ApiErrorCode } from "@/lib/apiError";
import { fileAbuseReportSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

const ABUSE_ERROR: Record<AbuseErrorCode, { code: ApiErrorCode; status: number }> = {
  INVALID: { code: "VALIDATION_ERROR", status: 400 },
  NOT_FOUND: { code: "NOT_FOUND", status: 404 },
  DUPLICATE: { code: "CONFLICT", status: 409 },
};

// GET /api/abuse-reports — the moderation queue (moderator only).
export async function GET(req: NextRequest) {
  if (!isModerator(req)) return apiError("FORBIDDEN", "Moderator access required", 403);
  const { searchParams } = new URL(req.url);
  const status = (searchParams.get("status") as AbuseStatus | null) ?? undefined;
  const targetAgent = searchParams.get("targetAgent") ?? undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
  return NextResponse.json({ reports: listReports({ status, targetAgent, limit }) });
}

// POST /api/abuse-reports — file a report against an agent (authenticated).
export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const ip = getClientIp(req);
  const rl = checkRateLimit(`abuse-report:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, fileAbuseReportSchema);
  if (!parsed.ok) return parsed.response;

  const result = fileReport({
    targetAgent: parsed.data.targetAgent,
    reporter: auth.user.walletAddress,
    reason: parsed.data.reason,
    details: parsed.data.details,
  });
  if (!result.success) {
    const mapped = ABUSE_ERROR[result.code];
    return apiError(mapped.code, result.error, mapped.status);
  }
  return NextResponse.json(result.report, { status: 201, headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
