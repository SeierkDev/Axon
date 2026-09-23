// What the burn pot is doing right now, read from the pot itself.
//
// getBurnStats in ./burn answers "what has this process sent toward the burn, and what has burned
// in total". This answers the other question, the one a countdown needs: when is the next burn
// allowed, how much would it spend, and is it waiting on the clock or on the market.
//
// Everything here comes off the chain. The pot's own preview() is the authority on the schedule,
// so the page never has to reimplement the interval rules and then disagree with the contract.

import { publicClient } from "./evm";
import { burnPotAddress } from "./burn";
import { weiToEth } from "./money";
import { logger } from "./logger";
import { EXPLORER } from "./chain";

/** Mirrors the constants in BurnPot.sol. Shown so the page can explain the schedule. */
export const BURN_RULES = {
  minIntervalSeconds: 30 * 60,
  burnsPerDay: 48,
  maxWaitSeconds: 24 * 60 * 60,
  minBurnEth: 0.001,
  depthPercent: 1,
  deadAddress: "0x000000000000000000000000000000000000dEaD",
} as const;

const POT_ABI = [
  { type: "function", name: "preview", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }], stateMutability: "view" },
  { type: "function", name: "lastBurnAt", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "burnCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalEthBurned", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalTokensBurned", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "token", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "startedAt", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

export interface BurnLive {
  /** false before the pot is deployed and configured: the page says so rather than showing zeros. */
  live: boolean;
  /** set once the token has launched through the pot. */
  launched: boolean;
  potAddress: string | null;
  tokenAddress: string | null;
  /** ETH sitting in the pot, waiting. */
  potBalanceEth: number;
  /** what the next burn would spend, which the depth cap can hold below the balance. */
  nextBurnEth: number;
  /** unix seconds. 0 when there is nothing scheduled. */
  nextBurnAt: number;
  lastBurnAt: number;
  /** true when burn() would go through this second. */
  ready: boolean;
  burnCount: number;
  totalEthBurned: number;
  totalTokensBurned: number;
  /** so the page can link every figure to somewhere it can be checked. */
  explorer: { pot: string | null; token: string | null; dead: string };
  rules: typeof BURN_RULES;
  /** when this was read, so a cached response still counts down correctly in the browser. */
  readAt: number;
}

const empty = (pot: string | null): BurnLive => ({
  live: false,
  launched: false,
  potAddress: pot,
  tokenAddress: null,
  potBalanceEth: 0,
  nextBurnEth: 0,
  nextBurnAt: 0,
  lastBurnAt: 0,
  ready: false,
  burnCount: 0,
  totalEthBurned: 0,
  totalTokensBurned: 0,
  explorer: {
    pot: pot ? `${EXPLORER}/address/${pot}` : null,
    token: null,
    dead: `${EXPLORER}/address/${BURN_RULES.deadAddress}`,
  },
  rules: BURN_RULES,
  readAt: Math.floor(Date.now() / 1000),
});

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Read the pot. Returns `live: false` rather than throwing when there is no pot yet or the node is
 * unreachable, because a burn page that 500s is worse than one that says it cannot reach the chain.
 */
export async function getBurnLive(): Promise<BurnLive> {
  const pot = burnPotAddress();
  if (!pot) return empty(null);

  try {
    const client = publicClient();
    const address = pot as `0x${string}`;
    type PotFn = (typeof POT_ABI)[number]["name"];
    const read = <T>(functionName: PotFn) =>
      client.readContract({ address, abi: POT_ABI, functionName }) as Promise<T>;

    // Settled rather than all or nothing. These are seven independent reads of one contract, and a
    // single failure used to discard the other six: one hiccup on preview() left the page saying the
    // pot was not live, showing four zeros, while the burns it had already done sat on chain in
    // plain sight. A page that loses its countdown is degraded. A page that says the burn does not
    // exist is wrong, on the page every burn post links to.
    const [preview, lastBurnAt, burnCount, ethBurned, tokensBurned, token, balance] =
      await Promise.allSettled([
        read<readonly [bigint, bigint, boolean]>("preview"),
        read<bigint>("lastBurnAt"),
        read<bigint>("burnCount"),
        read<bigint>("totalEthBurned"),
        read<bigint>("totalTokensBurned"),
        read<string>("token"),
        client.getBalance({ address }),
      ]);

    const settled = [preview, lastBurnAt, burnCount, ethBurned, tokensBurned, token, balance];
    const got = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
      r.status === "fulfilled" ? r.value : fallback;

    // Every read failing means the node is unreachable, and nothing here would be a fact. That case
    // still shows nothing, but it says why rather than making a claim about the pot.
    if (!settled.some((r) => r.status === "fulfilled")) {
      logger.warn("burn.live_unreadable", "Every burn pot read failed", { pot });
      return empty(pot);
    }

    const [amount, nextAt, ready] = got<readonly [bigint, bigint, boolean]>(preview, [0n, 0n, false]);
    const tokenRaw = got<string>(token, "");
    const tokenAddress = tokenRaw && tokenRaw !== ZERO ? tokenRaw.toLowerCase() : null;
    const burns = Number(got<bigint>(burnCount, 0n));

    return {
      live: true,
      // Unknown is not the same as no. If the token read is the one that failed, a pot that has
      // already burned is plainly launched, and the counter can say so by itself.
      launched: tokenAddress !== null || burns > 0,
      potAddress: pot,
      tokenAddress,
      potBalanceEth: weiToEth(got<bigint>(balance, 0n)),
      nextBurnEth: weiToEth(amount),
      nextBurnAt: Number(nextAt),
      lastBurnAt: Number(got<bigint>(lastBurnAt, 0n)),
      ready,
      burnCount: burns,
      totalEthBurned: weiToEth(got<bigint>(ethBurned, 0n)),
      totalTokensBurned: weiToEth(got<bigint>(tokensBurned, 0n)),
      explorer: {
        pot: `${EXPLORER}/address/${pot}`,
        token: tokenAddress ? `${EXPLORER}/address/${tokenAddress}` : null,
        dead: `${EXPLORER}/address/${BURN_RULES.deadAddress}`,
      },
      rules: BURN_RULES,
      readAt: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    logger.warn("burn.live_unreadable", "Could not read the burn pot", { err, pot });
    return empty(pot);
  }
}
