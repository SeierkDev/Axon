import { NextRequest, NextResponse } from "next/server";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { getAgentById } from "@/lib/agents";
import { createSpendMandate, listSpendMandates, revokeSpendMandate, getSpendMandate, spentInPeriod } from "@/lib/commerce";
import { spendMandateSchema, parseBody } from "@/lib/schemas";
import { recordAuditEvent } from "@/lib/audit";

export const runtime = "nodejs";

// Standing spend authority: "this agent may spend up to X per period against
// this profile". Separate from per-purchase approval on purpose — granting an
// agent a budget and agreeing to one specific order are different consents.
//
// GET    /api/commerce/mandates            — this owner's mandates, with spend to date
// POST   /api/commerce/mandates            — grant one
// DELETE /api/commerce/mandates?id=<id>    — revoke it

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const mandates = listSpendMandates(auth.user.walletAddress).map((m) => ({
    ...m,
    spentThisPeriod: m.status === "active" ? spentInPeriod(m) : 0,
  }));
  return NextResponse.json({ mandates });
}

export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const rl = checkRateLimit(`commerce-mandate:${auth.user.walletAddress}`, 20, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const raw = await req.json().catch(() => null);
    const parsed = parseBody(raw, spendMandateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const agent = getAgentById(body.agentId);
    if (!agent) return apiError("NOT_FOUND", `Agent '${body.agentId}' not found`, 404);
    // Only an agent's owner can hand it a budget.
    if (!canAccessIdentity(auth.user, body.agentId)) {
      return apiError("FORBIDDEN", "You do not own this agent", 403);
    }
    if (!agent.tools?.includes("commerce")) {
      return apiError(
        "VALIDATION_ERROR",
        `Agent '${body.agentId}' does not have the 'commerce' tool grant — add it before granting a budget`,
        400,
      );
    }
    if (body.autoApproveUnder != null && body.autoApproveUnder > body.maxPerPurchase) {
      return apiError(
        "VALIDATION_ERROR",
        "autoApproveUnder cannot exceed maxPerPurchase — that would auto-approve past your own cap",
        400,
      );
    }

    try {
      const mandate = createSpendMandate({ ownerWallet: auth.user.walletAddress, ...body });
      recordAuditEvent({
        req, actor: auth.user, action: "commerce.mandate_granted",
        resourceType: "spend_mandate", resourceId: mandate.mandateId,
        ownerAgentId: body.agentId, ownerWallet: auth.user.walletAddress,
        metadata: { maxPerPurchase: body.maxPerPurchase, maxPerPeriod: body.maxPerPeriod, period: mandate.period },
      });
      return NextResponse.json(mandate, { status: 201 });
    } catch (err) {
      return apiError("VALIDATION_ERROR", err instanceof Error ? err.message : "could not grant the mandate", 400);
    }
  });
}

export async function DELETE(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const mandateId = req.nextUrl.searchParams.get("id")?.trim();
    if (!mandateId) return apiError("VALIDATION_ERROR", "id is required", 400);

    const mandate = getSpendMandate(mandateId);
    if (!mandate) return apiError("NOT_FOUND", "Mandate not found", 404);
    if (mandate.ownerWallet !== auth.user.walletAddress) {
      return apiError("FORBIDDEN", "You do not own this mandate", 403);
    }

    const revoked = revokeSpendMandate(mandateId);
    recordAuditEvent({
      req, actor: auth.user, action: "commerce.mandate_revoked",
      resourceType: "spend_mandate", resourceId: mandateId,
      ownerAgentId: mandate.agentId, ownerWallet: auth.user.walletAddress,
      metadata: { alreadyRevoked: !revoked },
    });
    return NextResponse.json({ mandateId, revoked });
  });
}
