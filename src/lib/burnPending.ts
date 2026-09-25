import { publicClient } from "./evm";
import { splitterAddress } from "./burn";
import { weiToEth } from "./money";

// Fees that exist but have not reached the pot yet.
//
// The pot's balance is the only number the burn page has ever shown, and after graduation it is
// almost always zero — not because there are no fees, but because the pot is funded and burned
// within seconds of a release. Zero therefore means two completely different things, "nothing has
// been traded" and "money is one step away", and nothing on the page distinguishes them. That is
// what makes a perfectly healthy burn look stopped.
//
// This reads the step before the pot: what Pons has released into the escrow and our bot has not
// claimed yet. Normally zero too, because we claim every minute, but when it is not zero it is the
// difference between "quiet" and "about to burn".
//
// Read-only, and failure is not an error: every field is optional and the page falls back to what
// it showed before.

const SPLITTER_ABI = [
  { type: "function", name: "escrow", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

const ESCROW_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

/** The escrow is immutable on the splitter, so it is worth reading once rather than every request. */
let cachedEscrow: string | null | undefined;

async function escrowAddress(splitter: string): Promise<string | null> {
  if (cachedEscrow !== undefined) return cachedEscrow;
  try {
    const escrow = (await publicClient().readContract({
      address: splitter as `0x${string}`,
      abi: SPLITTER_ABI,
      functionName: "escrow",
    })) as string;
    cachedEscrow = escrow && !/^0x0{40}$/i.test(escrow) ? escrow : null;
  } catch {
    // Left undefined rather than cached as null: a transient RPC failure should not disable this
    // for the life of the process.
    return null;
  }
  return cachedEscrow;
}

/**
 * ETH released to us and waiting for the next claim, or null when it cannot be read.
 *
 * Null and zero are different answers and the page treats them differently: zero is "nothing is in
 * flight", null is "we could not check", and showing the first when you mean the second is the
 * whole problem this exists to fix.
 */
export async function getPendingAtPons(): Promise<number | null> {
  const splitter = splitterAddress();
  if (!splitter) return null;

  const escrow = await escrowAddress(splitter);
  if (!escrow) return null;

  try {
    const owed = (await publicClient().readContract({
      address: escrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "balanceOf",
      args: [splitter as `0x${string}`],
    })) as bigint;
    return weiToEth(owed);
  } catch {
    return null;
  }
}
