// GET  /api/agents/:agentId/budget — get budget + today's spend
// POST /api/agents/:agentId/budget — create or replace budget

import { NextRequest, NextResponse } from "next/server";
import { createBudget, getBudget, deleteBudget } from "@/lib/budgets";
import { requireAgentOwner } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";
import { createBudgetSchema, parseBody } from "@/lib/schemas";

type Params = { params: Promise<{ agentId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const budget = getBudget(agentId);
  if (!budget) {
    return NextResponse.json({ budget: null, message: "No budget configured for this agent" });
  }
  return NextResponse.json({ budget });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const parsed = parseBody(raw, createBudgetSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const budget = createBudget({
    agentId,
    name: body.name,
    maxPerCallUsdc: body.maxPerCallUsdc,
    maxPerDayUsdc: body.maxPerDayUsdc,
    allowedToAgents: body.allowedToAgents,
  });

  recordAuditEvent({
    req,
    actor: auth.user,
    action: "budget.upserted",
    resourceType: "budget",
    resourceId: budget.budgetId,
    ownerAgentId: agentId,
    metadata: {
      maxPerCallUsdc: budget.maxPerCallUsdc,
      maxPerDayUsdc: budget.maxPerDayUsdc,
      allowedToAgentsCount: budget.allowedToAgents?.length ?? 0,
    },
  });

  return NextResponse.json({ budget }, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  deleteBudget(agentId);
  return NextResponse.json({ ok: true });
}
