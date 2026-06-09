import { NextRequest, NextResponse } from "next/server";
import { getWorkflow } from "@/lib/workflows";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";

// GET /api/workflows/[workflowId]
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const { workflowId } = await params;
  const workflow = getWorkflow(workflowId);

  if (!workflow) {
    return apiError("NOT_FOUND", `Workflow '${workflowId}' not found`, 404);
  }
  const identities = [workflow.fromAgent, ...workflow.agents];
  if (!identities.some((identity) => canAccessIdentity(auth.user, identity))) {
    return apiError("FORBIDDEN", "API key does not have access to this workflow", 403);
  }

  return NextResponse.json(workflow);
}
