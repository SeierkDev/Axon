import { NextRequest, NextResponse } from "next/server";
import { resolveReport } from "@/lib/abuse";
import { isModerator } from "@/lib/moderation";
import { apiError } from "@/lib/apiError";
import { resolveAbuseReportSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

// POST /api/abuse-reports/[reportId]/resolve — moderate a report (moderator only).
export async function POST(req: NextRequest, ctx: { params: Promise<{ reportId: string }> }) {
  return withRequestContext(req, () => handlePost(req, ctx));
}

async function handlePost(req: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  if (!isModerator(req)) return apiError("FORBIDDEN", "Moderator access required", 403);

  const { reportId } = await params;
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, resolveAbuseReportSchema);
  if (!parsed.ok) return parsed.response;

  const result = resolveReport(reportId, parsed.data.status, parsed.data.resolution);
  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 400;
    const code = result.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR";
    return apiError(code, result.error, status);
  }
  return NextResponse.json(result.report);
}
