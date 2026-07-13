import { NextRequest, NextResponse } from "next/server";
import { prepareBuy } from "@/lib/integrations/agencGoods";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// POST /api/agenc/buy/prepare — the goods buy-through. Reads AgenC's on-chain
// goods listing and returns an UNSIGNED purchase_good transaction for the user's
// own wallet to sign. Spends no Axon SOL, holds no funds — public, rate-limited.
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`agenc-buy-prepare:${getClientIp(req)}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const body = (await req.json().catch(() => ({}))) as { goodPda?: unknown; buyerPubkey?: unknown };
  const goodPda = typeof body.goodPda === "string" ? body.goodPda.trim() : "";
  const buyerPubkey = typeof body.buyerPubkey === "string" ? body.buyerPubkey.trim() : "";
  if (!goodPda || !buyerPubkey) {
    return apiError("VALIDATION_ERROR", "goodPda and buyerPubkey are required", 400);
  }

  try {
    return NextResponse.json(await prepareBuy({ goodPda, buyerPubkey }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "prepare failed";
    // Client-side conditions (unbuyable good, sold out, self-purchase) aren't
    // upstream failures.
    if (/can't be bought|isn't supported|no longer for sale|sold out|self-purchase/.test(msg)) {
      return apiError("NOT_SUPPORTED", msg, 422);
    }
    return apiError("UPSTREAM_ERROR", msg, 502);
  }
}
