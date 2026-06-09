// GET /api/webhooks/failed?agentId=<id> — list all failed deliveries for an agent
// Shows deliveries that exhausted all 5 retry attempts without a 2xx response.

import { NextRequest, NextResponse } from "next/server";
import { getFailedDeliveries } from "@/lib/webhooks";
import { requireAgentOwner } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";

export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get("agentId");
  if (!agentId) {
    return apiError("VALIDATION_ERROR", "agentId is required", 400);
  }
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const limit = Math.min(
    100,
    Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10) || 50)
  );

  const deliveries = getFailedDeliveries(agentId, limit);
  return NextResponse.json({ count: deliveries.length, deliveries });
}
