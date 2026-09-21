// Whether the burn is actually still running.
//
// The burn fires itself now, which is the point of it, and also the problem: a thing that needs
// nobody is a thing nobody is looking at. If the loop stops, or the wallet that pays the gas runs
// dry, the countdown on the page keeps ticking and nothing burns. The first person to notice
// would be someone in the replies asking why.
//
// So this is the part that notices. Three ways it can quietly stop:
//
//   the loop died          the server restarted into a state where it never started, or every
//                          tick is throwing. Caught by nothing having been checked recently.
//   the gas ran out        each burn costs a fraction of a cent, but the bot wallet is finite and
//                          nobody tops it up automatically. Caught before it is empty, not after.
//   burns stopped landing  due for far longer than an interval with a fundable pot behind it.
//
// A burn being merely late is not any of these. Below MIN_BURN the pot waits by design, and if
// trading goes quiet overnight that wait is correct, so the check asks whether a burn *could*
// have happened rather than whether one did.

import { publicClient } from "./evm";
import { burnPotAddress } from "./burn";
import { burnLoopState } from "./burnLoop";
import { weiToEth } from "./money";
import { privateKeyToAccount } from "viem/accounts";
import { parseAbi } from "viem";

const POT_ABI = parseAbi([
  "function preview() view returns (uint256 amount, uint256 nextAt, bool ready)",
  "function lastBurnAt() view returns (uint256)",
  "function burnCount() view returns (uint256)",
]);

/** Typical gas for one burn, measured on this chain rather than guessed. */
const GAS_PER_BURN_ETH = 0.000012;
/** Warn while there is still a month of headroom, not on the last tank. */
const LOW_GAS_BURNS = 200;
/** A burn ready and fundable for this long means something is wrong, not merely quiet. */
const STALL_SECONDS = 20 * 60;
/** The loop checks every few seconds; a minute of silence means it is not running. */
const LOOP_SILENT_SECONDS = 60;

export interface BurnHealth {
  ok: boolean;
  /** each problem in plain words, empty when there are none */
  problems: string[];
  configured: boolean;
  loopRunning: boolean;
  lastCheckAgoSeconds: number | null;
  burnCount: number;
  lastBurnAgoSeconds: number | null;
  readyForSeconds: number | null;
  gas: { address: string | null; eth: number; burnsRemaining: number } | null;
  lastError: string | null;
}

export async function burnHealth(): Promise<BurnHealth> {
  const pot = burnPotAddress();
  const key = process.env.BOT_PRIVATE_KEY?.trim();
  const loop = burnLoopState();
  const now = Math.floor(Date.now() / 1000);

  const health: BurnHealth = {
    ok: true,
    problems: [],
    configured: Boolean(pot && key),
    loopRunning: loop.started,
    lastCheckAgoSeconds: loop.lastCheckAt ? now - loop.lastCheckAt : null,
    burnCount: 0,
    lastBurnAgoSeconds: null,
    readyForSeconds: null,
    gas: null,
    lastError: loop.lastError,
  };

  // Nothing to be unhealthy about before the pot exists.
  if (!health.configured) return health;

  try {
    const client = publicClient();
    const address = pot as `0x${string}`;
    const [preview, lastBurnAt, burnCount] = await Promise.all([
      client.readContract({ address, abi: POT_ABI, functionName: "preview" }) as Promise<
        readonly [bigint, bigint, boolean]
      >,
      client.readContract({ address, abi: POT_ABI, functionName: "lastBurnAt" }) as Promise<bigint>,
      client.readContract({ address, abi: POT_ABI, functionName: "burnCount" }) as Promise<bigint>,
    ]);
    const [amount, nextAt, ready] = preview;

    health.burnCount = Number(burnCount);
    health.lastBurnAgoSeconds = lastBurnAt > 0n ? now - Number(lastBurnAt) : null;
    health.readyForSeconds = ready && nextAt > 0n ? now - Number(nextAt) : null;

    const bot = privateKeyToAccount(
      (key!.startsWith("0x") ? key! : `0x${key!}`) as `0x${string}`,
    );
    const balance = await client.getBalance({ address: bot.address });
    const eth = weiToEth(balance);
    health.gas = {
      address: bot.address,
      eth,
      burnsRemaining: Math.floor(eth / GAS_PER_BURN_ETH),
    };

    // ── the three ways it stops ──────────────────────────────────────────
    if (!loop.started) {
      health.problems.push("the burn loop is not running in this process");
    } else if (health.lastCheckAgoSeconds !== null && health.lastCheckAgoSeconds > LOOP_SILENT_SECONDS) {
      health.problems.push(`the burn loop has not checked for ${health.lastCheckAgoSeconds}s`);
    }

    if (health.gas.burnsRemaining < LOW_GAS_BURNS) {
      health.problems.push(
        `the bot wallet has gas for about ${health.gas.burnsRemaining} more burns, top it up`,
      );
    }

    // Ready, fundable, and still sitting there: that is a stall rather than the pot waiting.
    if (ready && amount > 0n && (health.readyForSeconds ?? 0) > STALL_SECONDS) {
      health.problems.push(
        `a burn has been due and fundable for ${Math.floor((health.readyForSeconds ?? 0) / 60)} minutes`,
      );
    }
  } catch (err) {
    health.problems.push(
      `could not read the chain: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
    );
  }

  health.ok = health.problems.length === 0;
  return health;
}
