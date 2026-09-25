import type { NextRequest } from "next/server";
import { authenticateApiKey } from "./identity";
import { getTier, type Tier, type TierName } from "./holderTier";
import { checkRateLimit, getClientIp, type RateLimitResult } from "./rateLimit";
import { logger } from "./logger";

// Free hires, widened by what a wallet holds.
//
// This is the only tier benefit that spends money. A paid hire arrives with ETH and the buyer
// covered its inference; a free one is inference bought for somebody with no revenue against it. So
// an allowance of N free calls costs roughly N times the average free-call cost, per holder, and
// that is a real cheque rather than a setting.
//
// Which is why the numbers are deliberately conservative and live in the environment. What a task
// actually costs is now countable (see ./spendSummary and /api/admin/spend-summary), and the
// sensible order is: ship a low ceiling, read the real figure off production, then raise it
// knowingly. Guessing high and finding out later is the expensive direction.
//
// Base is unchanged at three, exactly as it has always been. Nobody loses a free call to this.

/** The window. A year, so refreshing a page never resets somebody's quota. */
export const FREE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/** What the free lane has always given, and still gives, to everyone. */
export const BASE_FREE_CALLS = 3;

/**
 * Free calls per tier.
 *
 * Conservative on purpose: these are inference the project pays for. Overridable with
 * `AXON_FREE_CALLS=10,25,50` (holder, builder, operator) so the ceiling can be raised from real
 * spend figures without a deploy.
 */
export const DEFAULT_FREE_CALLS: Record<TierName, number> = {
  base: BASE_FREE_CALLS,
  holder: 10,
  builder: 25,
  operator: 50,
};

export function freeCallsFor(tier: Tier): number {
  const raw = process.env.AXON_FREE_CALLS?.trim();
  if (!raw) return DEFAULT_FREE_CALLS[tier.name] ?? BASE_FREE_CALLS;

  const parts = raw.split(",").map((p) => Number(p.trim()));
  const ok =
    parts.length === 3 &&
    parts.every((n) => Number.isInteger(n) && n >= BASE_FREE_CALLS) &&
    parts.every((n, i) => i === 0 || n >= parts[i - 1]!);

  if (!ok) {
    // Half-applying this would either bill the project for calls nobody agreed to or quietly cut
    // somebody's allowance. Ignored whole, and said out loud.
    logger.warn("free.allowance_ignored", "AXON_FREE_CALLS is not three rising integers at or above the base", { raw });
    return DEFAULT_FREE_CALLS[tier.name] ?? BASE_FREE_CALLS;
  }

  const byName: Record<TierName, number> = { base: BASE_FREE_CALLS, holder: parts[0]!, builder: parts[1]!, operator: parts[2]! };
  // Never below the base, whatever the setting says.
  return Math.max(BASE_FREE_CALLS, byName[tier.name] ?? BASE_FREE_CALLS);
}

export interface FreeAllowance {
  result: RateLimitResult;
  tier: Tier;
  /** Calls this caller is entitled to in the window. */
  allowance: number;
}

/**
 * Spend one free call against the caller's allowance.
 *
 * `scope` distinguishes the two free lanes that exist: hiring a particular agent, and the streaming
 * demo. They have always had separate quotas and still do.
 *
 * A holder is counted per wallet, so their allowance follows them rather than being tied to an
 * address they happen to be behind. Base-tier callers stay on exactly the key they always used,
 * authenticated or not — giving them a second bucket keyed by wallet would hand every API key three
 * extra free calls on top of the three their IP already has, which is a loophole rather than a perk.
 */
export async function checkFreeAllowance(req: NextRequest, scope: string): Promise<FreeAllowance> {
  const ip = getClientIp(req);

  let wallet: string | null = null;
  try {
    wallet = authenticateApiKey(req)?.walletAddress ?? null;
  } catch {
    /* an unreadable key is simply not an identity here */
  }

  const { tier } = wallet ? await getTier(wallet) : { tier: { name: "base" as const, minimum: 0, rank: 0 } };
  const allowance = freeCallsFor(tier);

  // Only a tier that actually earns more gets its own bucket. Base keeps the IP key it has always
  // had, so nothing about the existing free lane changes for anyone.
  const key = tier.rank > 0 && wallet ? `free-demo:w:${wallet.toLowerCase()}:${scope}` : `free-demo:${ip}:${scope}`;

  return { result: checkRateLimit(key, allowance, FREE_WINDOW_MS), tier, allowance };
}

/** What to tell somebody who has run out, without pretending a wallet alone would help. */
export function freeLimitMessage(a: FreeAllowance): string {
  return a.tier.rank > 0
    ? `You've used your ${a.allowance} free calls. Holding more $AXON raises the allowance, or hire a paid agent to keep going.`
    : `You've used your ${a.allowance} free demo calls. Connect your MetaMask wallet at axon-agents.com/onboarding to get an API key and continue.`;
}
