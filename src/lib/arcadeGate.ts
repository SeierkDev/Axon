// Axon Arcade — the freemium gate: playing is free, RANKING takes skin in the
// game. A finished time only enters the leaderboard if the connected wallet
// holds >= GATE_AMOUNT $AXON. Times always display locally either way.
//
// Casual-leaderboard trust model (documented, deliberate): the client reports
// the wallet with the run; we verify the BALANCE on-chain but not wallet
// ownership (no signature challenge — nothing pays out on this board). If the
// node is down we fail OPEN: an outage shouldn't eat a legitimate climb.
//
// The same posture covers the token not existing yet. Before the launch there is
// nothing to hold, so the gate is open rather than shut against everybody.

import { logger } from "./logger";
import { normalizeAddress } from "./address";
import { publicClient } from "./evm";

export const GATE_AMOUNT = 1000; // whole $AXON tokens

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; holds: boolean }>();

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;

function tokenAddress(): string | null {
  return normalizeAddress(process.env.AXON_TOKEN_ADDRESS);
}

/** Does this wallet hold at least GATE_AMOUNT $AXON? Cached 5 minutes per wallet. */
export async function holdsAxon(wallet: string): Promise<boolean> {
  const owner = normalizeAddress(wallet);
  if (!owner) return false;

  const token = tokenAddress();
  if (!token) return true; // no token configured yet, so there is nothing to gate on

  const hit = cache.get(owner);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.holds;

  try {
    const client = publicClient();
    // Read the decimals rather than assuming them: a threshold compared against the wrong scale
    // either lets everyone in or nobody.
    const [balance, decimals] = await Promise.all([
      client.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [owner as `0x${string}`],
      }),
      client.readContract({ address: token as `0x${string}`, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    const threshold = BigInt(GATE_AMOUNT) * 10n ** BigInt(decimals as number);
    const holds = (balance as bigint) >= threshold;
    cache.set(owner, { at: Date.now(), holds });
    return holds;
  } catch (err) {
    // Fail open — a leaderboard entry is not worth blocking on an outage.
    // NOT cached: the next call retries for a real answer.
    logger.warn("arcade.gate_rpc_failed", "AXON gate balance check failed, allowing", { err });
    return true;
  }
}

// Test seam.
export function _clearGateCache(): void {
  cache.clear();
}
