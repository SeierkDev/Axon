import { NextRequest, NextResponse } from "next/server";
import { instantiateTemplate, getTemplateById } from "@/lib/workflowTemplates";
import { getAgentById } from "@/lib/agents";
import { isValidSolanaAddress } from "@/lib/solana";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError, type ApiErrorCode } from "@/lib/apiError";
import { instantiateTemplateSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

// POST /api/workflow-templates/[templateId]/instantiate — run the template as
// the caller: resolve its task with the given params and start a real workflow.
export async function POST(req: NextRequest, ctx: { params: Promise<{ templateId: string }> }) {
  return withRequestContext(req, () => handlePost(req, ctx));
}

async function handlePost(req: NextRequest, { params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`workflow-instantiate:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const template = getTemplateById(templateId);
  if (!template) return apiError("NOT_FOUND", `Template '${templateId}' not found`, 404);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, instantiateTemplateSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!isValidSolanaAddress(body.from) && !getAgentById(body.from)) {
    return apiError("VALIDATION_ERROR", "from must be a valid Solana address or agent ID", 400);
  }
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, body.from)) {
    return apiError("FORBIDDEN", "from must be your wallet address or an agent you own", 403);
  }

  const result = instantiateTemplate(templateId, body.from, body.params ?? {});
  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 400;
    const code: ApiErrorCode = result.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR";
    return apiError(code, result.error, status);
  }
  return NextResponse.json({ workflow: result.workflow }, { status: 201, headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
