// What the pool says an ETH is worth in $AXON.
//
// Not an oracle and not a number anyone here chooses. $AXON graduated off its bonding curve, so its
// liquidity sits in a Uniswap v4 pool, and the price is a slot in the pool manager. This reads the
// same slot, by the same derivation, that BurnPot._market() already uses in production to size every
// burn. Two places agreeing is the point: if this read were wrong, the burns would be wrong too, and
// they demonstrably are not.
//
// The arithmetic is exact. sqrtPriceX96 squared is a 320-bit number and JavaScript bigints do not
// overflow, so nothing here goes near a float. That matters more than usual: a rounding error does
// not throw, it quotes the wrong price.

import { encodeAbiParameters, keccak256, encodePacked, parseAbi, encodeFunctionData } from "viem";
import { RPC_URL } from "./chain";
import { LAUNCHPAD_FACTORY } from "./launchIndex";
import { AXON_TOKEN_ADDRESS } from "./money";

/** v4-core StateLibrary: the pools mapping lives at slot 6, and sqrtPriceX96 is the first word. */
const POOLS_SLOT = 6n;
const Q192 = 2n ** 192n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

const LAUNCHED = parseAbi([
  "function getLaunchedToken(address) view returns ((address,address,address,address,address,uint256,uint24,int24,uint16,bool,uint8,uint256,uint256,uint256,bool))",
]);
const EXTSLOAD = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
const POOL_MANAGER = parseAbi(["function poolManager() view returns (address)"]);
const MEME_HOOK = parseAbi(["function memeHook() view returns (address)"]);

async function ethCall(to: string, data: `0x${string}`): Promise<string | null> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(6000),
    });
    const body = (await res.json()) as { result?: string };
    return typeof body.result === "string" && body.result !== "0x" ? body.result : null;
  } catch {
    return null;
  }
}

const addressFrom = (word: string) => `0x${word.slice(-40)}`;

export interface PoolPrice {
  /** the pool's price, as the chain stores it */
  sqrtPriceX96: bigint;
  /** whole $AXON per whole ETH, for display only. Never used to compute an amount. */
  axonPerEth: number;
}

/**
 * The live price, or null if there is nowhere to read one.
 *
 * Null is a real answer rather than an error: before graduation, between graduation and pool
 * creation, or after a Pons rescue, there is no pool and so no rate. A quote cannot be issued then,
 * and saying so is better than inventing a number.
 */
export async function readPoolPrice(): Promise<PoolPrice | null> {
  if (!AXON_TOKEN_ADDRESS) return null;

  const info = await ethCall(
    LAUNCHPAD_FACTORY,
    encodeFunctionData({ abi: LAUNCHED, functionName: "getLaunchedToken", args: [AXON_TOKEN_ADDRESS as `0x${string}`] }),
  );
  if (!info) return null;

  const words = info.slice(2).match(/.{64}/g);
  if (!words || words.length < 11) return null;

  // Word order is the LaunchedToken struct: token, curve, deployer, creatorFeeRecipient, pairToken,
  // graduationThreshold, poolFee, tickSpacing, creatorTaxBps, buybackEnabled, phase, ...
  const poolFee = Number(BigInt(`0x${words[6]}`));
  const tickSpacing = Number(BigInt(`0x${words[7]}`));
  const phase = Number(BigInt(`0x${words[10]}`));

  // 2 is PoolCreated. Anything else means there is no pool to price against.
  if (phase !== 2) return null;

  const [pmRaw, hookRaw] = await Promise.all([
    ethCall(LAUNCHPAD_FACTORY, encodeFunctionData({ abi: POOL_MANAGER, functionName: "poolManager" })),
    ethCall(LAUNCHPAD_FACTORY, encodeFunctionData({ abi: MEME_HOOK, functionName: "memeHook" })),
  ]);
  if (!pmRaw || !hookRaw) return null;

  const poolManager = addressFrom(pmRaw);
  const hook = addressFrom(hookRaw);

  // ETH is currency0 because its address is zero, which also fixes the direction of the price below.
  const poolId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [ZERO, AXON_TOKEN_ADDRESS as `0x${string}`, poolFee, tickSpacing, hook as `0x${string}`],
    ),
  );
  const slot = keccak256(encodePacked(["bytes32", "uint256"], [poolId, POOLS_SLOT]));

  const raw = await ethCall(poolManager, encodeFunctionData({ abi: EXTSLOAD, functionName: "extsload", args: [slot] }));
  if (!raw) return null;

  const sqrtPriceX96 = BigInt(raw) & ((1n << 160n) - 1n);
  if (sqrtPriceX96 === 0n) return null;

  return { sqrtPriceX96, axonPerEth: Number(axonForWei(10n ** 18n, sqrtPriceX96)) / 1e18 };
}

/**
 * How much $AXON settles a debt of `wei`.
 *
 * currency0 is ETH and currency1 is $AXON, so the pool's price is already $AXON per ETH and no
 * inversion is needed. Both sides have eighteen decimals, so the raw ratio is the human one.
 *
 * Integer division truncates, which rounds in the payer's favour by at most one unit of a token worth
 * a tiny fraction of a cent. Rounding the other way would refuse someone who sent exactly what they
 * were told to send, which is the failure that actually matters.
 */
export function axonForWei(wei: bigint, sqrtPriceX96: bigint): bigint {
  if (wei <= 0n || sqrtPriceX96 <= 0n) return 0n;
  return (wei * sqrtPriceX96 * sqrtPriceX96) / Q192;
}
