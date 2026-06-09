import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { getAgentMetrics } from "@/lib/metrics";
import { apiError } from "@/lib/apiError";

type Params = { params: Promise<{ agentId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { agentId } = await params;
  if (!getAgentById(agentId)) {
    return apiError("NOT_FOUND", "Agent not found", 404);
  }

  const days = Math.min(
    90,
    Math.max(1, parseInt(req.nextUrl.searchParams.get("days") ?? "30", 10) || 30)
  );

  const metrics = getAgentMetrics(agentId, days);
  return NextResponse.json(metrics);
}
