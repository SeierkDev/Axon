import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { getPurchaseIntent } from "@/lib/commerce";
import { discoverBusiness, getCheckout, UcpError } from "@/lib/ucp";

export const runtime = "nodejs";

// GET /api/commerce/intents/<intentId>/payment
//
// Which payment handler the buyer's browser must run to produce a credential for
// this purchase. Read live from the business rather than stored at proposal
// time: a business can change handlers, and the session has to be
// `ready_for_complete` before a completion call is worth attempting anyway.
//
// Only handler identifiers and the business's own public config are returned —
// there is nothing sensitive here, and nothing of the buyer's.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const { intentId } = await params;
  const intent = getPurchaseIntent(intentId);
  // Same shape as a miss for someone else's purchase — don't confirm it exists.
  if (!intent || intent.ownerWallet !== auth.user.walletAddress) {
    return apiError("NOT_FOUND", `Purchase intent '${intentId}' not found`, 404);
  }
  if (!intent.checkoutId) {
    return apiError("CONFLICT", "This purchase has no open checkout session", 409);
  }

  try {
    const business = await discoverBusiness(intent.businessHost);
    const session = await getCheckout(business, intent.checkoutId);
    return NextResponse.json({
      intentId,
      businessHost: intent.businessHost,
      status: session.status,
      readyToComplete: session.readyToComplete,
      // The live total, so the browser can refuse to pay a number that moved
      // away from what the buyer is being shown.
      total: session.total,
      currency: session.currency,
      approvedCeiling: intent.maxAmount,
      paymentHandlers: session.paymentHandlers,
      messages: session.messages,
    });
  } catch (err) {
    const code = err instanceof UcpError ? err.code : "UPSTREAM_ERROR";
    return apiError("UPSTREAM_ERROR", err instanceof Error ? err.message : "could not read the checkout session", 502, {
      reason: code,
    });
  }
}
