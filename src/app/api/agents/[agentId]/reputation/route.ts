import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { computeReputation } from "@/lib/reputation";
import { apiError } from "@/lib/apiError";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  if (!getAgentById(agentId)) {
    return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
  }

  return NextResponse.json(computeReputation(agentId));
}
