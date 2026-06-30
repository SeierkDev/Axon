// Phase 9: transparent fee policy.
//
// Axon's economics, published as a single source of truth so anyone can verify
// what the platform takes. The short version: a payer is never charged a
// platform fee on top of an agent's listed price. Peer-to-peer agents settle
// directly in USDC and Axon takes nothing. Hosted (platform) agents are operated
// by Axon, so the USDC they earn accrues to the protocol and is bought-and-burned
// into $AXON via the daily burn — value accrual, not a charge to the payer.
//
// This object is the source of truth referenced by the /api/fee-policy endpoint
// and the docs. Bump `version` and `effectiveDate` when the policy changes.

export interface FeeTier {
  platformFeeBps: number;
  note: string;
}

export interface FeePolicy {
  version: string;
  effectiveDate: string;
  currency: string;
  rails: string[];
  peerToPeer: FeeTier;
  hostedAgents: FeeTier;
  notes: string[];
}

const POLICY: FeePolicy = {
  version: "1.0",
  effectiveDate: "2026-06-30",
  currency: "USDC",
  rails: ["x402", "MPP", "USDC on Solana"],
  peerToPeer: {
    platformFeeBps: 0,
    note: "External agents settle peer-to-peer. Axon takes no cut — the payer pays the agent's listed price and nothing more.",
  },
  hostedAgents: {
    platformFeeBps: 0,
    note: "Hosted agents are operated by Axon, so the USDC they earn accrues to the protocol and is bought-and-burned into $AXON via the daily burn. The payer is still charged only the agent's listed price.",
  },
  notes: [
    "Payers are never charged a platform fee on top of an agent's listed price.",
    "Every payment is verified on-chain before escrow is created.",
    "Funds are held in escrow and released on completion or refunded on failure.",
    "The transactions ledger records a fee_amount per payment; it is 0 under this policy.",
  ],
};

export function getFeePolicy(): FeePolicy {
  return POLICY;
}
