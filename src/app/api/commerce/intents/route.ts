import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { listPurchaseIntents, expireStaleIntents, spendSummary, intentsAwaitingOrderStatus } from "@/lib/commerce";
import { refreshOrderStatus } from "@/lib/commerceComplete";

export const runtime = "nodejs";

// GET /api/commerce/intents — what this owner's agents have proposed, approved,
// and actually bought. The statement behind the approvals: approvals without a
// ledger is half a product.
export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  // Sweep first so nothing shows as pending that can no longer be redeemed.
  expireStaleIntents();

  // Order status is refreshed when someone actually looks, not by a background
  // job — this is a feature for the buyer, not a platform crawler. Bounded and
  // opt-in so opening the page never hangs on somebody else's slow store.
  if (req.nextUrl.searchParams.get("refresh") === "1") {
    const mine = intentsAwaitingOrderStatus(5, auth.user.walletAddress);
    await Promise.allSettled(mine.map((i) => refreshOrderStatus(i.intentId)));
  }

  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 50, 1), 200);
  const status = req.nextUrl.searchParams.get("status")?.trim() || undefined;
  const intents = listPurchaseIntents(auth.user.walletAddress, limit, status);

  return NextResponse.json({
    intents,
    summary: spendSummary(auth.user.walletAddress),
  });
}
