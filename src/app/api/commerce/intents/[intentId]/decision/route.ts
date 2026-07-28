import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { approvePurchase, declinePurchase, getPurchaseIntent, CommerceError } from "@/lib/commerce";
import { attachMandate, mandateMessage, completeApprovedPurchase } from "@/lib/commerceComplete";
import { recordAuditEvent } from "@/lib/audit";

export const runtime = "nodejs";

// POST /api/commerce/intents/<intentId>/decision  { "decision": "approve" | "decline" }
//
// The human gate. An agent can propose a purchase; only this endpoint, called by
// the buyer's own key, turns a proposal into something redeemable — and even
// then only against the ceiling and TTL the proposal was created with.
// GET /api/commerce/intents/<intentId>/decision — the exact text the buyer's
// wallet must sign to approve. Self-describing on purpose: a signature is
// worthless if the signer couldn't tell what they were agreeing to.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const { intentId } = await params;
  const intent = getPurchaseIntent(intentId);
  if (!intent || intent.ownerWallet !== auth.user.walletAddress) {
    return apiError("NOT_FOUND", `Purchase intent '${intentId}' not found`, 404);
  }
  return NextResponse.json({
    intentId,
    message: mandateMessage(intent),
    wallet: intent.ownerWallet,
    expiresAt: intent.expiresAt,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const rl = checkRateLimit(`commerce-decision:${auth.user.walletAddress}`, 60, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const { intentId } = await params;
    const body = await req.json().catch(() => null) as {
      decision?: string;
      signature?: string;
      paymentInstrument?: { id: string; handlerId: string; type: string; credential: Record<string, unknown>; billingAddress?: Record<string, unknown> };
    } | null;
    const decision = body?.decision;
    if (decision !== "approve" && decision !== "decline") {
      return apiError("VALIDATION_ERROR", 'decision must be "approve" or "decline"', 400);
    }

    const existing = getPurchaseIntent(intentId);
    if (!existing) return apiError("NOT_FOUND", `Purchase intent '${intentId}' not found`, 404);
    if (existing.ownerWallet !== auth.user.walletAddress) {
      // Same shape as a miss: don't confirm the existence of someone else's purchase.
      return apiError("NOT_FOUND", `Purchase intent '${intentId}' not found`, 404);
    }

    // Check the window before the signature. An expired intent should say so,
    // rather than failing on a signature mismatch and sending the buyer looking
    // for a wallet problem they don't have.
    if (decision === "approve" && existing.expiresAt <= new Date().toISOString()) {
      return apiError("CONFLICT", `Intent is '${existing.status}' and has expired — it can no longer be approved`, 409);
    }

    // Approving means signing. AP2 wants non-repudiable proof the buyer agreed to
    // this exact cart at this exact price, so the signature IS the approval —
    // recorded before the status flips, or not at all.
    if (decision === "approve") {
      if (!body?.signature) {
        return apiError(
          "VALIDATION_ERROR",
          "signature is required to approve — sign the message from GET on this endpoint with the buyer's wallet",
          400,
        );
      }
      try {
        attachMandate(intentId, body.signature);
      } catch (err) {
        const code = err instanceof CommerceError ? err.code : "BAD_SIGNATURE";
        return apiError("VALIDATION_ERROR", err instanceof Error ? err.message : "invalid signature", 400, { reason: code });
      }
    }

    const updated =
      decision === "approve"
        ? approvePurchase(intentId, auth.user.walletAddress)
        : declinePurchase(intentId, auth.user.walletAddress);

    if (!updated) {
      // Already decided, already spent, or the window closed while they thought
      // about it — say which, because "no" and "too late" are different.
      return apiError(
        "CONFLICT",
        `Intent is '${existing.status}'${existing.expiresAt <= new Date().toISOString() ? " and has expired" : ""} — it can no longer be ${decision}d`,
        409,
      );
    }

    recordAuditEvent({
      req, actor: auth.user, action: `commerce.purchase_${decision}d`,
      resourceType: "purchase_intent", resourceId: intentId,
      ownerAgentId: updated.agentId, ownerWallet: auth.user.walletAddress,
      metadata: { amount: updated.amount, currency: updated.currency, businessHost: updated.businessHost },
    });

    if (decision === "decline") return NextResponse.json(updated);

    // UCP needs a payment credential as well as the signature: signing authorises
    // the purchase, it doesn't pay for it. The credential comes from one of the
    // business's payment handlers, on the buyer's side — so without one we stop
    // here with the approval intact rather than pretending the order went through.
    if (!body?.paymentInstrument) {
      return NextResponse.json(
        {
          ...updated,
          purchaseError:
            "Approved and signed, but no payment credential was supplied — complete it with a payment instrument from one of the business's handlers.",
          reason: "NO_PAYMENT_INSTRUMENT",
        },
        { status: 202 },
      );
    }

    // Approved and signed — place the order. A failure here leaves the intent
    // approved and signed so it can be retried; the buyer doesn't have to
    // authorise the same purchase twice because a business had a bad minute.
    try {
      const result = await completeApprovedPurchase(intentId, body.paymentInstrument);
      return NextResponse.json({ ...result.intent, orderId: result.orderId, settledAmount: result.settledAmount });
    } catch (err) {
      const reason = err instanceof CommerceError ? err.code : "CHECKOUT_FAILED";
      return NextResponse.json(
        { ...getPurchaseIntent(intentId), purchaseError: err instanceof Error ? err.message : "checkout failed", reason },
        { status: 502 },
      );
    }
  });
}
