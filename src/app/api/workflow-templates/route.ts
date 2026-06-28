import { NextRequest, NextResponse } from "next/server";
import { createTemplate, listTemplates, type TemplateErrorCode } from "@/lib/workflowTemplates";
import { getAgentById } from "@/lib/agents";
import { isValidSolanaAddress } from "@/lib/solana";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError, type ApiErrorCode } from "@/lib/apiError";
import { createWorkflowTemplateSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const TEMPLATE_ERROR: Record<TemplateErrorCode, { code: ApiErrorCode; status: number }> = {
  INVALID: { code: "VALIDATION_ERROR", status: 400 },
  NOT_FOUND: { code: "NOT_FOUND", status: 404 },
  DUPLICATE: { code: "CONFLICT", status: 409 },
};

// GET /api/workflow-templates — discover templates (public).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") ?? undefined;
  const limitRaw = searchParams.get("limit");
  const limitParsed = limitRaw ? parseInt(limitRaw, 10) : undefined;
  const limit = limitParsed !== undefined && Number.isFinite(limitParsed) ? limitParsed : undefined;
  return NextResponse.json({ templates: listTemplates({ from, limit }) });
}

// POST /api/workflow-templates — create a reusable workflow template.
export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`workflow-templates:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, createWorkflowTemplateSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!isValidSolanaAddress(body.from) && !getAgentById(body.from)) {
    return apiError("VALIDATION_ERROR", "from must be a valid Solana address or agent ID", 400);
  }
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, body.from)) {
    return apiError("FORBIDDEN", "from must be your wallet address or an agent owned by your wallet", 403);
  }

  const result = createTemplate({
    fromAgent: body.from,
    name: body.name,
    description: body.description,
    agents: body.agents,
    taskTemplate: body.taskTemplate,
  });
  if (!result.success) {
    const mapped = TEMPLATE_ERROR[result.code];
    return apiError(mapped.code, result.error, mapped.status);
  }
  return NextResponse.json(result.template, { status: 201, headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
