import { NextRequest, NextResponse } from "next/server";
import { getTier, tiers } from "@/lib/holderTier";
import { TIER_MULTIPLIER } from "@/lib/tieredRateLimit";
import { freeCallsFor } from "@/lib/freeAllowance";
import { limitsForTier } from "@/lib/agentTierLimits";
import { isWalletAddress } from "@/lib/address";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * GET /api/tier?wallet=0x…
 *
 * What a wallet holds and what that entitles it to. Public, because every input is: the balance is
 * on chain and the ladder is published. Nothing here is a secret about the wallet, and making
 * somebody authenticate to read a public balance would be theatre.
 *
 * Without a wallet it answers with the ladder alone, which is what the page needs before anyone
 * has connected anything.
 */
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`tier:${getClientIp(req)}`, 60, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const ladder = tiers().map((t) => ({
    name: t.name,
    rank: t.rank,
    minimum: t.minimum,
    entitlements: {
      rateMultiplier: TIER_MULTIPLIER[t.name] ?? 1,
      freeCalls: freeCallsFor(t),
      queuePriority: t.rank,
      agent: limitsForTier(t),
    },
  }));

  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet) {
    return NextResponse.json({ wallet: null, tier: null, ladder }, { headers: CORS });
  }
  if (!isWalletAddress(wallet)) {
    return apiError("VALIDATION_ERROR", "wallet must be a 0x address", 400);
  }

  const { tier, balance, stale } = await getTier(wallet);
  const current = ladder.find((t) => t.name === tier.name) ?? ladder[0]!;
  const next = ladder.find((t) => t.rank === tier.rank + 1) ?? null;

  return NextResponse.json(
    {
      wallet: wallet.toLowerCase(),
      balance,
      /** True when the balance could not be read just now and a cached tier is being honoured. */
      stale,
      tier: current,
      next: next ? { name: next.name, minimum: next.minimum, needed: balance === null ? null : Math.max(0, next.minimum - balance) } : null,
      ladder,
    },
    // Short. A balance moves the moment somebody trades, and a tier that lags behind the wallet by
    // an hour would have people refreshing a page that insists they hold nothing.
    { headers: { "Cache-Control": "public, max-age=30", ...CORS } },
  );
}

export const dynamic = "force-dynamic";
