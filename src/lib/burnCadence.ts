import { publicClient } from "./evm";
import { burnPage } from "./burnHistory";
import { logger } from "./logger";

// What is actually holding the next burn back, measured rather than assumed.
//
// The pot burns when two conditions are both met: thirty minutes since the last burn, and at least
// 0.001 ETH sitting in it. Which of those two is the binding one depends entirely on how often fees
// arrive, and that is not ours to decide. After the token graduated, trading fees collect at Pons
// and only Pons releases them to us.
//
// When they release often, the thirty minutes is what you are waiting for: the pot fills, holds a
// visible balance, and the countdown means something. When they release less often than every
// thirty minutes, the cooldown has always already expired by the time money lands, so the pot is
// funded and burned within seconds and its balance reads zero every time anyone looks. Same
// contract, same bot, opposite-looking page.
//
// A page with "every thirty minutes" written into it is wrong in the second case and has no way to
// notice. So nothing here is written down: the cadence is measured from the burns that actually
// happened, and the page says what the measurement says. If Pons goes back to releasing often, the
// measurement moves on its own and so does the wording.
//
// Read-only. Nothing in this file decides when to burn, and nothing it returns is used by the burn
// engine. It only describes what already happened.

/** Burns to measure over. Long enough to survive one odd gap, short enough to track a real change. */
const SAMPLE = 8;
/** Below this many burns there is nothing worth calling a cadence. */
const MIN_SAMPLE = 4;
/**
 * How far past the cooldown a typical gap has to sit before deliveries, not the clock, are clearly
 * the constraint. Burns land a little after the thirty minutes even at full speed — the bot polls,
 * and blocks take time — so a small margin here keeps a healthy fast cadence reading as
 * cooldown-bound instead of flapping between the two descriptions.
 */
const DELIVERY_BOUND_FACTOR = 1.35;

export interface BurnCadence {
  /** Typical seconds between recent burns. Null when too few burns to say. */
  medianGapSeconds: number | null;
  /** How many gaps that median is drawn from. */
  sample: number;
  /**
   * `cooldown` — fees arrive faster than the pot may burn, so the thirty minutes is the wait.
   * `delivery` — fees arrive slower than that, so the wait is for fees, and the cooldown is spent
   *   long before they land.
   */
  boundBy: "cooldown" | "delivery" | "unknown";
  /** Best guess at when fees next reach the pot, unix seconds. Null unless delivery-bound. */
  nextDeliveryEstimate: number | null;
}

export const UNKNOWN_CADENCE: BurnCadence = {
  medianGapSeconds: null,
  sample: 0,
  boundBy: "unknown",
  nextDeliveryEstimate: null,
};

/** Seconds per block on this chain, measured rather than assumed, and cached. */
let blockSeconds: { value: number; at: number } | null = null;
const BLOCK_SECONDS_TTL_MS = 10 * 60_000;
const BLOCK_SPAN = 20_000n;

async function secondsPerBlock(): Promise<number | null> {
  if (blockSeconds && Date.now() - blockSeconds.at < BLOCK_SECONDS_TTL_MS) return blockSeconds.value;
  try {
    const client = publicClient();
    const head = await client.getBlockNumber();
    if (head <= BLOCK_SPAN) return null;
    const [now, then] = await Promise.all([
      client.getBlock({ blockNumber: head }),
      client.getBlock({ blockNumber: head - BLOCK_SPAN }),
    ]);
    const seconds = (Number(now.timestamp) - Number(then.timestamp)) / Number(BLOCK_SPAN);
    // A nonsensical answer is worse than no answer: it would put a confident wrong number on the
    // page. Anything outside a sane band for this chain is treated as unreadable.
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) return null;
    blockSeconds = { value: seconds, at: Date.now() };
    return seconds;
  } catch {
    return null;
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Measure the recent burn cadence.
 *
 * Deliberately built on burns we have already stored rather than a fresh log scan: this is read on
 * a public page, and a page that walks the chain on every request is a page that falls over exactly
 * when people are looking at it.
 *
 * `cooldownSeconds` is passed in rather than imported so this module owes nothing to the one that
 * calls it. An import cycle between the two would leave whichever loaded second holding undefined
 * constants, on the page where a wrong number is least acceptable.
 */
export async function getBurnCadence(lastBurnAt: number, cooldownSeconds: number): Promise<BurnCadence> {
  try {
    const { burns } = burnPage(SAMPLE + 1);
    if (burns.length < MIN_SAMPLE + 1) return UNKNOWN_CADENCE;

    const perBlock = await secondsPerBlock();
    if (perBlock === null) return UNKNOWN_CADENCE;

    // burnPage returns newest first; consecutive pairs are the gaps.
    const gaps: number[] = [];
    for (let i = 0; i < burns.length - 1; i++) {
      const blocks = burns[i]!.blockNumber - burns[i + 1]!.blockNumber;
      if (blocks > 0) gaps.push(blocks * perBlock);
    }
    if (gaps.length < MIN_SAMPLE) return UNKNOWN_CADENCE;

    const gap = median(gaps);
    const boundBy = gap > cooldownSeconds * DELIVERY_BOUND_FACTOR ? "delivery" : "cooldown";

    return {
      medianGapSeconds: Math.round(gap),
      sample: gaps.length,
      boundBy,
      // Only meaningful when fees are the constraint. When the cooldown binds, the contract's own
      // nextBurnAt is the honest countdown and this would be a second opinion about the same thing.
      nextDeliveryEstimate: boundBy === "delivery" && lastBurnAt > 0 ? Math.round(lastBurnAt + gap) : null,
    };
  } catch (err) {
    logger.warn("burn.cadence_failed", "Could not measure burn cadence", { err });
    return UNKNOWN_CADENCE;
  }
}
