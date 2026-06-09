import { NextRequest, NextResponse } from "next/server";
import { getAgentById, updateAgent } from "@/lib/agents";
import { apiError } from "@/lib/apiError";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { validatePublicHttpUrl } from "@/lib/urlSecurity";
import { updateAgentSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

// GET /api/agents/[agentId]
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);

  if (!agent) {
    return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
  }

  return NextResponse.json(agent);
}

// PATCH /api/agents/[agentId] — update mutable agent fields
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const { agentId } = await params;
    const agent = getAgentById(agentId);
    if (!agent) return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);

    if (!canAccessIdentity(auth.user, agentId)) {
      return apiError("FORBIDDEN", "You do not own this agent", 403);
    }

    const raw = await req.json().catch(() => null);
    const parsed = parseBody(raw, updateAgentSchema);
    if (!parsed.ok) return parsed.response;
    const updates = parsed.data;

    // DNS/security check for endpoint — Zod validates URL format; this validates reachability
    if (updates.endpoint != null) {
      const urlError = await validatePublicHttpUrl(updates.endpoint);
      if (urlError !== null) {
        return apiError("VALIDATION_ERROR", `endpoint: ${urlError}`, 400);
      }
    }

    const updated = updateAgent(agentId, updates);
    return NextResponse.json(updated);
  });
}
