import { normalizeAddress } from "./address";
import { publicClient } from "./evm";
import { logger } from "./logger";

// What a wallet's $AXON balance entitles it to.
//
// Holding the token does nothing today. Spending it works — agents take $AXON and some discount for
// it — but a holder who never hires anything gets nothing from the network they own a piece of.
// This is the other half: the balance sets a tier, and the tier buys real limits.
//
// Two rules the whole design rests on:
//
//   Tiers only ever ADD. Nobody loses anything they have today. The base tier is exactly the
//   network as it stands, so a wallet with no $AXON, or no wallet at all, is unaffected. Gating
//   away something people already use would read as a rug, and would deserve to.
//
//   Nothing is staked, locked, escrowed or transferred. This reads a balance. There is no contract
//   to deploy, no approval to sign, and no way for any of it to touch anyone's funds. Sell at any
//   time and the tier simply drops at the next read.
//
// What hangs off it: rate limits, the free-call allowance, queue priority, how deep an agent may
// go on a paid job, and how many names its owner may hold in reserve.

export type TierName = "base" | "holder" | "builder" | "operator";

export interface Tier {
  name: TierName;
  /** Whole $AXON at or above which this tier applies. */
  minimum: number;
  /** Position in the ladder, 0 being the network as it is today. */
  rank: number;
}

/**
 * The ladder.
 *
 * Each rung is ten times the last, which keeps the spread wide enough that the tiers mean different
 * things. Entry is low enough that anyone genuinely using the network clears it without thinking
 * about it; the top rung is one percent of supply, which is rare by construction.
 *
 * Deliberately not the arcade's 1,000 gate. That number gates a leaderboard on a game and is meant
 * to be trivial to clear. These gate real throughput and real spend, and a threshold that costs
 * nothing buys nothing.
 *
 * Overridable, because the right values depend on how supply is actually distributed and on a price
 * that moves. A ladder written into a binary would need a deploy to answer the market.
 */
export const DEFAULT_TIERS: Tier[] = [
  { name: "base", minimum: 0, rank: 0 },
  { name: "holder", minimum: 250_000, rank: 1 },
  { name: "builder", minimum: 2_500_000, rank: 2 },
  { name: "operator", minimum: 10_000_000, rank: 3 },
];

export const BASE_TIER: Tier = DEFAULT_TIERS[0]!;

/**
 * Thresholds, overridable without a deploy.
 *
 * `AXON_TIER_THRESHOLDS=250000,2500000,10000000`. Anything malformed is ignored in favour of the
 * defaults: a half-parsed ladder would silently move everyone's entitlements, which is worse than
 * ignoring the setting and saying so.
 */
export function tiers(): Tier[] {
  const raw = process.env.AXON_TIER_THRESHOLDS?.trim();
  if (!raw) return DEFAULT_TIERS;

  const parts = raw.split(",").map((p) => Number(p.trim()));
  const ok =
    parts.length === DEFAULT_TIERS.length - 1 &&
    parts.every((n) => Number.isFinite(n) && n > 0) &&
    parts.every((n, i) => i === 0 || n > parts[i - 1]!);

  if (!ok) {
    logger.warn("tier.thresholds_ignored", "AXON_TIER_THRESHOLDS is not a rising list of positive numbers", { raw });
    return DEFAULT_TIERS;
  }
  return [BASE_TIER, ...parts.map((minimum, i) => ({ name: DEFAULT_TIERS[i + 1]!.name, minimum, rank: i + 1 }))];
}

/** The tier a whole-token balance earns. */
export function tierForBalance(whole: number): Tier {
  let earned = BASE_TIER;
  for (const tier of tiers()) if (whole >= tier.minimum) earned = tier;
  return earned;
}

export interface TierResult {
  tier: Tier;
  /** Whole $AXON held, or null when the balance could not be read. */
  balance: number | null;
  /**
   * True when this came from a cached reading because the chain could not be reached just now.
   * The tier is still honoured: a holder should not lose their limits because a node blinked.
   */
  stale: boolean;
}

const CACHE_MS = 5 * 60 * 1000;
/** Kept past expiry on purpose, so an outage can serve the last good answer rather than none. */
const cache = new Map<string, { at: number; balance: number; tier: Tier }>();

const ERC20_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;

export const UNKNOWN: TierResult = { tier: BASE_TIER, balance: null, stale: false };

/** Only for tests, which must not inherit another test's cached wallet. */
export function _clearTierCache(): void {
  cache.clear();
}

/**
 * Resolve a wallet's tier.
 *
 * Never throws and never blocks: an unreadable chain degrades to the last known tier, or to base,
 * which is the network exactly as it behaves today. Since tiers only add, degrading can cost a
 * holder a benefit for a few minutes but can never deny anyone something they had before any of
 * this existed.
 */
export async function getTier(wallet: string | null | undefined): Promise<TierResult> {
  const owner = wallet ? normalizeAddress(wallet) : null;
  // Anonymous callers are the majority — MCP clients and free-lane hires carry no wallet at all —
  // and they get the network as it stands, which is the point of base being unchanged.
  if (!owner) return UNKNOWN;

  const token = normalizeAddress(process.env.AXON_TOKEN_ADDRESS);
  if (!token) return UNKNOWN;

  const hit = cache.get(owner);
  if (hit && Date.now() - hit.at < CACHE_MS) return { tier: hit.tier, balance: hit.balance, stale: false };

  try {
    const client = publicClient();
    // Read decimals rather than assume them. A threshold compared against the wrong scale either
    // promotes everybody or nobody, and both are silent.
    const [raw, decimals] = await Promise.all([
      client.readContract({ address: token as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [owner as `0x${string}`] }),
      client.readContract({ address: token as `0x${string}`, abi: ERC20_ABI, functionName: "decimals" }),
    ]);

    // Whole tokens, floored. Thresholds are stated in whole $AXON, and comparing in wei would make
    // 999.999999 read as 1,000 on one path and not the other.
    const whole = Number((raw as bigint) / 10n ** BigInt(decimals as number));
    const tier = tierForBalance(whole);
    cache.set(owner, { at: Date.now(), balance: whole, tier });
    return { tier, balance: whole, stale: false };
  } catch (err) {
    logger.warn("tier.balance_read_failed", "Could not read $AXON balance for tier", { err, owner });
    if (hit) return { tier: hit.tier, balance: hit.balance, stale: true };
    return UNKNOWN;
  }
}
