// GET  /api/agents/:agentId/optimize — recommend a price from the agent's own receipts
// POST /api/agents/:agentId/optimize — recommend, and (with { apply: true }) commit it
//
// Phase 11 self-optimization: an agent tunes its own price from its track record.

import { NextRequest, NextResponse } from "next/server";
import { computeOptimization, applyOptimization } from "@/lib/selfOptimize";
import { requireAgentOwner } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";
import { optimizeSchema, parseBody } from "@/lib/schemas";

type Params = { params: Promise<{ agentId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const optimization = computeOptimization(agentId);
  if (!optimization) return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
  return NextResponse.json({ optimization, applied: false });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const raw = await req.json().catch(() => ({}));
  const parsed = parseBody(raw && typeof raw === "object" ? raw : {}, optimizeSchema);
  if (!parsed.ok) return parsed.response;

  const optimization = computeOptimization(agentId);
  if (!optimization) return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);

  let applied = false;
  if (parsed.data.apply && optimization.action !== "hold" && optimization.suggestedPrice) {
    applyOptimization(agentId, optimization.suggestedPrice);
    applied = true;
    recordAuditEvent({
      req,
      actor: auth.user,
      action: "agent.self_optimized",
      resourceType: "agent",
      resourceId: agentId,
      ownerWallet: auth.user.walletAddress,
      metadata: {
        from: optimization.currentPrice,
        to: optimization.suggestedPrice,
        action: optimization.action,
        successRate: optimization.metrics.successRate,
      },
    });
  }

  return NextResponse.json({ optimization, applied });
}
