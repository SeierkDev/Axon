import { NextRequest, NextResponse } from "next/server";
import { getAgentBalance } from "@/lib/payments";
import { requireAgentOwner } from "@/lib/apiAuth";

// GET /api/agents/[agentId]/balance — earnings and spending summary
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  return NextResponse.json(getAgentBalance(agentId));
}
