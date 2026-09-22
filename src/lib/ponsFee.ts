// What Pons charges to launch, asked of Pons.
//
// The launch page used to carry the fee as a string in the browser bundle: parseEther("0.0005"), correct on
// the day it was written. BurnPot reverts with LaunchFeeShort when msg.value is under the real fee, so the
// day Pons raises it, every launch fails in the wallet with nothing on our side having changed. A number
// that lives on someone else's contract is not ours to copy.
//
// Cached, because the answer moves rarely and the page asks on every load.

import { RPC_URL } from "./chain";
import { LAUNCHPAD_FACTORY } from "./launchIndex";

const LAUNCH_FEE = "0xcf3cf573"; // launchFee()
const FALLBACK_WEI = 500_000_000_000_000n; // 0.0005 ETH, the fee at the time of writing
const TTL_MS = 10 * 60 * 1000;

let cached: { wei: bigint; at: number } | null = null;

/** For tests, which must not inherit a value another test put here. */
export function clearPonsFeeCache(): void {
  cached = null;
}

/**
 * The launch fee in wei.
 *
 * Falls back to the last known fee if the RPC is unreachable rather than throwing, because a page that
 * cannot read the fee should still render: the wallet would reject a short launch anyway, and that is a
 * clearer failure than an eligibility check that 500s.
 */
export async function ponsLaunchFeeWei(): Promise<bigint> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.wei;

  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: LAUNCHPAD_FACTORY, data: LAUNCH_FEE }, "latest"],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { result?: string };
    const raw = body.result;
    if (typeof raw === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(raw) && raw !== "0x") {
      const wei = BigInt(raw);
      // A zero fee is a malformed answer rather than a free launch, and sending zero would revert.
      if (wei > 0n) {
        cached = { wei, at: Date.now() };
        return wei;
      }
    }
  } catch {
    /* fall through to the last known fee */
  }

  return cached?.wei ?? FALLBACK_WEI;
}
