import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { getPurchaseIntent } from "@/lib/commerce";

export const runtime = "nodejs";

// GET /api/commerce/intents/<intentId> — one purchase.
//
// The `purchase.proposed` webhook hands out an intentId and nothing else, so
// without this the only way to act on it is to list every purchase and search
// for it — which quietly depends on the one you want being on the first page.
// A purchase you were notified about should be directly readable.
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

  // The signature itself is never returned — `signed` says whether there is one.
  const { mandateSignature: _sig, ...safe } = intent as typeof intent & { mandateSignature?: string };
  void _sig;
  return NextResponse.json(safe);
}
