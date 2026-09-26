// The burn, fired the moment it is allowed.
//
// This started as a cron. A cron is the wrong shape for it: every run spins up a container, so
// even at one minute the burn goes out some unpredictable time after it becomes due, and at five
// it was late enough that three burns in a row got fired by hand first. "Due" has to mean now.
//
// So it lives in the running server instead, as a loop that is already awake. It reads the pot
// every few seconds, which costs nothing, and calls burn() the second the pot says yes.
//
// The two halves run at different rates on purpose:
//
//   the burn check  is a read. Cheap, so it happens every few seconds and the burn goes out
//                   within seconds of becoming allowed.
//   the sweep       is a transaction and costs gas. Running it every few seconds would burn gas
//                   all day to move nothing, so it keeps its own slower clock.
//
// The pot's own thirty minute interval still decides how often a burn actually happens. Nothing
// here can make one happen early: burn() reverts with TooSoon and the loop simply tries again.

import { parseAbi } from "viem";
import { publicClient, walletClientFor } from "./evm";
import { burnPotAddress, splitterAddress } from "./burn";
import { weiToEth } from "./money";
import { logger } from "./logger";

const POT_ABI = parseAbi([
  "function preview() view returns (uint256 amount, uint256 nextAt, bool ready)",
  "function burn(uint256 minTokensOut) returns (uint256 ethIn, uint256 tokensOut)",
]);
const SPLITTER_ABI = parseAbi(["function sweep() returns (uint256)"]);

/** How often the pot is asked whether a burn is allowed. A read, so this can be tight. */
const CHECK_MS = Number(process.env.AXON_BURN_CHECK_MS ?? 5_000);
/** How often fees are swept in. A transaction, so this stays slow. */
const SWEEP_MS = Number(process.env.AXON_SWEEP_MS ?? 5 * 60_000);
/** The contract's own note says 0 is what the bot should pass; the depth cap is the protection. */
const MIN_TOKENS_OUT = 0n;

export interface LoopState {
  started: boolean;
  checkMs: number;
  sweepMs: number;
  lastCheckAt: number | null;
  lastBurnHash: string | null;
  lastError: string | null;
}

// Everything the loop remembers lives in one object on globalThis, not in module variables.
//
// The server loads this module more than once: instrumentation has its own copy, and so does the
// code serving requests (the burn-engine route starts the loop there on purpose, so /api/burn/health
// can see it). With per-copy variables each copy ran its own loop, so every boot had two loops
// sweeping and racing each other to burn, the loser reverting and paying gas for it. One shared
// object means one loop, whichever copy starts it first, and every copy reading the same state.
interface Shared {
  running: boolean;
  lastSweep: number;
  /** Set while a burn transaction is in flight, so a slow confirm cannot start a second one. */
  burning: boolean;
  lastComplaint: number;
  state: LoopState;
}
const shared: Shared = ((globalThis as typeof globalThis & { __axonBurnLoop?: Shared }).__axonBurnLoop ??= {
  running: false,
  lastSweep: 0,
  burning: false,
  lastComplaint: 0,
  state: {
    started: false,
    checkMs: CHECK_MS,
    sweepMs: SWEEP_MS,
    lastCheckAt: null,
    lastBurnHash: null,
    lastError: null,
  },
});
const state = shared.state;
export const burnLoopState = (): LoopState => ({ ...state });

function why(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const named = text.match(/\b(TooSoon|TooSmall|MarketNotReady|NothingToBurn|TokenNotSet)\b/);
  return named ? named[1] : text.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** How often the loop is allowed to complain, so a stall does not fill the log every tick. */
const COMPLAIN_EVERY_MS = 15 * 60_000;

/**
 * Say something when the burn has stopped working.
 *
 * Only for the two states nobody would otherwise notice: a burn sitting due and fundable, and the
 * gas running low. A burn waiting below MIN_BURN is the pot doing its job and is not mentioned.
 */
function complainIfStuck(readyForSeconds: number, amount: bigint, gasEth: number): void {
  if (Date.now() - shared.lastComplaint < COMPLAIN_EVERY_MS) return;
  const problems: string[] = [];
  if (amount > 0n && readyForSeconds > 20 * 60) {
    problems.push(`a burn has been due and fundable for ${Math.floor(readyForSeconds / 60)} minutes`);
  }
  if (gasEth > 0 && gasEth < 0.0024) {
    problems.push(`the bot wallet is down to ${gasEth.toFixed(5)} ETH of gas`);
  }
  if (problems.length === 0) return;
  shared.lastComplaint = Date.now();
  logger.error("burn.stuck", "The burn is not running as it should", { problems });
}

async function tick(): Promise<void> {
  const pot = burnPotAddress();
  const key = process.env.BOT_PRIVATE_KEY?.trim();
  if (!pot || !key) return;

  const reader = publicClient();
  const { account, client } = walletClientFor(key);
  state.lastCheckAt = Math.floor(Date.now() / 1000);

  // Sweep on its own slower clock, and never in the way of a burn.
  const splitter = splitterAddress();
  if (splitter && Date.now() - shared.lastSweep >= SWEEP_MS) {
    shared.lastSweep = Date.now();
    try {
      const hash = await client.writeContract({
        address: splitter as `0x${string}`,
        abi: SPLITTER_ABI,
        functionName: "sweep",
        account,
        chain: null,
      });
      await reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
    } catch {
      // Reverts when there is nothing on the curve yet, which is most of the time.
    }
  }

  if (shared.burning) return;

  try {
    const [amount, nextAt, ready] = (await reader.readContract({
      address: pot as `0x${string}`,
      abi: POT_ABI,
      functionName: "preview",
    })) as readonly [bigint, bigint, boolean];

    // Noticed here rather than only when somebody asks, so a stall reaches the log on its own.
    if (ready && nextAt > 0n) {
      const readyFor = Math.floor(Date.now() / 1000) - Number(nextAt);
      const gas = await reader.getBalance({ address: account.address }).catch(() => 0n);
      complainIfStuck(readyFor, amount, weiToEth(gas));
    }

    if (!ready || amount <= 0n) return;

    shared.burning = true;
    try {
      const hash = await client.writeContract({
        address: pot as `0x${string}`,
        abi: POT_ABI,
        functionName: "burn",
        args: [MIN_TOKENS_OUT],
        account,
        chain: null,
      });
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status === "success") {
        state.lastBurnHash = hash;
        state.lastError = null;
        logger.info("burn.fired", "Burned from the pot", { hash, ethIn: weiToEth(amount) });
      } else {
        state.lastError = `burn ${hash} reverted`;
      }
    } finally {
      shared.burning = false;
    }
  } catch (err) {
    // TooSoon between burns is the schedule working. Recorded, never raised.
    state.lastError = why(err);
  }
}

/**
 * Start the loop. Safe to call more than once; only the first call starts anything.
 *
 * Deliberately not an interval: a tick that runs long would otherwise overlap the next one. Each
 * tick schedules the next after it finishes.
 */
export function startBurnLoop(): void {
  if (shared.running) return;
  if (!burnPotAddress() || !process.env.BOT_PRIVATE_KEY?.trim()) return;
  shared.running = true;
  state.started = true;

  const schedule = () => setTimeout(loop, CHECK_MS).unref?.();
  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      state.lastError = why(err);
    }
    schedule();
  };
  logger.info("burn.loop_started", "Burn loop running", { checkMs: CHECK_MS, sweepMs: SWEEP_MS });
  schedule();
}
