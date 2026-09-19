// Multi-protocol payment path advisor.
// Helps callers choose between x402 (per-call on-chain) and MPP (pre-paid channel)
// based on call frequency, available channels, and agent pricing.

export type PaymentProtocol = "x402" | "mpp" | "free";

export interface PaymentPathRecommendation {
  protocol: PaymentProtocol;
  reason: string;
  priceString?: string;
}

export interface PaymentPathOptions {
  agentPrice?: string;
  hasOpenMppChannel?: boolean;
  expectedCallsPerDay?: number;
}

// MPP wins when the caller already has an open channel — the per-call overhead drops from one
// on-chain transaction to a database debit.
// At >= 5 calls/day the amortised gas savings tip clearly in MPP's favour.
export function recommendPaymentPath(
  opts: PaymentPathOptions
): PaymentPathRecommendation {
  const { agentPrice, hasOpenMppChannel = false, expectedCallsPerDay = 1 } = opts;

  if (!agentPrice) {
    return { protocol: "free", reason: "Agent is free, no payment required" };
  }

  // One currency, so there is no longer a "can this even go through a channel" question. What is
  // left is whether the caller has a channel and whether the traffic justifies using it.
  if (hasOpenMppChannel && expectedCallsPerDay >= 5) {
    return {
      protocol: "mpp",
      reason: `Pre-paid MPP channel recommended: ${expectedCallsPerDay} calls/day eliminates per-call on-chain fees`,
      priceString: agentPrice,
    };
  }

  if (hasOpenMppChannel) {
    return {
      protocol: "mpp",
      reason: "Pre-paid MPP channel available, use it to avoid on-chain fees",
      priceString: agentPrice,
    };
  }

  return {
    protocol: "x402",
    reason: "No open MPP channel, defaulting to x402 on-chain payment",
    priceString: agentPrice,
  };
}
