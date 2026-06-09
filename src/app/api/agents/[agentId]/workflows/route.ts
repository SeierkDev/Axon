import { NextRequest, NextResponse } from "next/server";
import { getWorkflowsByAgent } from "@/lib/workflows";
import { requireAgentOwner } from "@/lib/apiAuth";

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 20;
}

// GET /api/agents/[agentId]/workflows
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));
  const workflows = getWorkflowsByAgent(agentId, limit);

  return NextResponse.json({ workflows, total: workflows.length });
}
