// What an agent's $AXON terms look like to a person.
//
// The payment side of this was built first and worked before anything here existed: an agent asks
// for the price over x402 and gets back both options, ETH and $AXON at whatever discount the agent
// set. That is machine to machine, and it left the website silent about it. Somebody deciding
// whether to hold the token could read every page on the site and never learn that it buys agent
// work, which is the entire argument for holding it.
//
// So this turns the two stored fields into the words shown on a card and on an agent's page. Kept
// as one pure function rather than written twice, because a card saying 20% beside a page saying 25%
// is worse than neither saying anything: the discount is a claim about what someone will be charged.
//
// No database and no imports beyond the type, so the client components that render the marketplace
// can use it directly.

import type { Agent } from "@/sdk/types";

/** Basis points in one whole. */
const BPS = 10_000;

/**
 * The most an agent may knock off for paying in the token.
 *
 * This lives here rather than beside the database code because three places need it and one of them
 * is the browser: the schema that accepts an owner's setting, the write that stores it, and the
 * badge that advertises it. A copy per caller is how a listing ends up promising a discount the
 * payment side refuses, so there is one.
 */
export const MAX_AXON_DISCOUNT_BPS = 5_000;

/**
 * An agent's discount setting, or zero.
 *
 * Anything outside the range is no discount rather than the nearest legal one. 50000 instead of
 * 5000 is the mistake basis points invite, and snapping it down would turn a typo into a real
 * half-price offer on a public listing.
 */
export function clampDiscount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_AXON_DISCOUNT_BPS) return 0;
  return n;
}

export interface AxonTerms {
  /** the discount actually shown, after clamping */
  discountBps: number;
  /** "20%", "12.5%", or "" when the agent takes $AXON at full price */
  discount: string;
  /** for a badge, where there is room for about two words */
  short: string;
  /** for a sentence, where the reader has already decided to look closer */
  long: string;
}

/** 2000 becomes "20%", 1250 becomes "12.5%". Trailing zeros are dropped so nothing reads as "20.0%". */
function percent(bps: number): string {
  const value = (bps / BPS) * 100;
  return `${Number(value.toFixed(2))}%`;
}

/**
 * What to say about this agent, or null when there is nothing to say.
 *
 * Null in two cases. An agent that has not opted in obviously gets nothing. So does a free agent:
 * a discount off nothing is nothing, and a badge offering to take payment for an unpaid task is a
 * worse listing than no badge at all.
 */
export function axonTerms(
  agent: Pick<Agent, "acceptsAxon" | "axonDiscountBps" | "price">,
): AxonTerms | null {
  if (!agent.acceptsAxon) return null;
  if (!agent.price?.trim()) return null;

  // The same clamp the stored terms use, so the badge can never advertise what the write refused.
  const bps = clampDiscount(agent.axonDiscountBps);

  if (bps === 0) {
    return {
      discountBps: 0,
      discount: "",
      short: "Pays in $AXON",
      long: "This agent accepts $AXON as payment, at the same price as ETH.",
    };
  }

  const discount = percent(bps);
  return {
    discountBps: bps,
    discount,
    short: `$AXON ${discount} off`,
    long: `This agent takes ${discount} off when the task is paid in $AXON.`,
  };
}
