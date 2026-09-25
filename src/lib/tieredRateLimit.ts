import type { NextRequest } from "next/server";
import { authenticateApiKey } from "./identity";
import { getTier, BASE_TIER, type Tier, type TierName } from "./holderTier";
import { checkRateLimit, getClientIp, type RateLimitResult } from "./rateLimit";

// Rate limits that widen with what a wallet holds.
//
// The first thing a holder actually feels. Throughput is a real scarce resource — every request is
// compute somebody pays for — so giving more of it to holders is worth something, and costs no
// model spend at all.
//
// Two things this deliberately does not do.
//
// It never lowers anyone's limit. Base is the limit the endpoint has always had, so an anonymous
// caller, a wallet holding nothing, or anyone during an RPC outage gets exactly what they get
// today. The multipliers only multiply up.
//
// It never trusts a claim. A caller cannot say which wallet they are: the wallet comes from the API
// key they authenticated with, which is bound to it. Anonymous callers — most MCP traffic — have no
// wallet to read and stay on base, which is the correct answer rather than a limitation.

/**
 * How far each tier widens a limit.
 *
 * Multipliers rather than absolute numbers, so every endpoint keeps its own sense of what a
 * reasonable base is. A limit of 60/min and one of 5/min should not become the same number just
 * because the same wallet is calling them.
 */
export const TIER_MULTIPLIER: Record<TierName, number> = {
  base: 1,
  holder: 2,
  builder: 5,
  operator: 10,
};

/** The limit a tier is entitled to on an endpoint whose base is `baseLimit`. */
export function limitFor(baseLimit: number, tier: Tier): number {
  const factor = TIER_MULTIPLIER[tier.name] ?? 1;
  // Never below the base. A multiplier misconfigured under 1 would quietly take throughput away
  // from holders, which is the one thing this is not allowed to do.
  return Math.max(baseLimit, Math.round(baseLimit * factor));
}

export interface TieredRateLimit {
  result: RateLimitResult;
  tier: Tier;
  /** The limit actually applied, after the tier. */
  limit: number;
  /** The wallet the tier came from, when the caller authenticated. */
  wallet: string | null;
}

/**
 * Check a rate limit, widened by the caller's tier.
 *
 * Authenticated callers are counted per wallet rather than per IP, so a holder's throughput follows
 * them between machines and is not shared with everyone behind the same address. Anonymous callers
 * stay keyed by IP exactly as before.
 *
 * Never throws: a failed tier read degrades to base, which is the endpoint's existing behaviour.
 */
export async function checkTieredRateLimit(
  req: NextRequest,
  prefix: string,
  baseLimit: number,
  windowMs: number,
): Promise<TieredRateLimit> {
  let wallet: string | null = null;
  try {
    wallet = authenticateApiKey(req)?.walletAddress ?? null;
  } catch {
    // A malformed or unknown key is simply not an identity. It is not an error here: the request
    // still gets the anonymous limit, and whatever the route does about auth is the route's call.
  }

  if (!wallet) {
    return {
      result: checkRateLimit(`${prefix}:${getClientIp(req)}`, baseLimit, windowMs),
      tier: BASE_TIER,
      limit: baseLimit,
      wallet: null,
    };
  }

  const { tier } = await getTier(wallet);
  const limit = limitFor(baseLimit, tier);
  return {
    result: checkRateLimit(`${prefix}:w:${wallet.toLowerCase()}`, limit, windowMs),
    tier,
    limit,
    wallet,
  };
}
