// Who actually holds a token.
//
// This is the reading people trust most and the only one here that is genuinely expensive. There
// is no holder index on this chain and no explorer API to ask, so the only way to know is to
// replay every Transfer the token has ever emitted and add them up.
//
// That is affordable because of one thing: the launch index already knows which block the token
// was created in, so the replay has a floor. A token that launched this morning is a few queries.
// Without that floor it would be a walk back through the whole chain.
//
// It is still capped, hard. Almost nothing on this chain trades, so most tokens cost nearly
// nothing to read, but the few that matter are exactly the ones with the most transfers. Past the
// cap this returns "unavailable" rather than hanging a page or hammering the node, because a
// report that loads without a holder list beats a report that does not load.

import { withRpc } from "./evm";
import { logger } from "./logger";

/** Transfer(address indexed from, address indexed to, uint256 value) */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

/** The node's ceiling on one getLogs range. */
const WINDOW = 100_000n;

/** Windows fetched together. The node answers 429 when pushed, same as the launch index. */
const PARALLEL = 4;

/** Past this many windows the token is older than this is willing to replay. */
const MAX_WINDOWS = 40;

/** Past this many transfers the arithmetic is fine but the wait is not. */
const MAX_TRANSFERS = 25_000;

const rpc = <T>(method: string, params: unknown[]) => withRpc((request) => request<T>(method, params));

interface RawLog {
  topics: string[];
  data: string;
}

export interface Holder {
  address: string;
  balance: string;
  share: number;
  /** set when we know what this address is, so a big number is not misread */
  label: "bonding curve" | "burned" | "creator" | null;
}

export interface HolderReport {
  available: boolean;
  /** why not, in words the page can show */
  reason: string | null;
  holders: Holder[];
  /** addresses with a non-zero balance, excluding the dead address */
  holderCount: number;
  transfersRead: number;
  /** what the top ten hold between them, ignoring the curve and burned supply */
  topTenShare: number | null;
}

const unavailable = (reason: string): HolderReport => ({
  available: false, reason, holders: [], holderCount: 0, transfersRead: 0, topTenShare: null,
});

/**
 * Replays are expensive and the busiest tokens are both the most expensive and the most looked at,
 * so without this the cost lands on every single visitor to the one page people actually open.
 *
 * Short lived on purpose: balances move, and a holder list that is minutes stale is honest while
 * one that is hours stale is not. Failures are cached too, briefly, so a token that is over the
 * cap does not pay for discovering that again on every load.
 */
const CACHE_MS = 3 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;
const cache = new Map<string, { at: number; report: HolderReport }>();

/** Stop the map growing without limit on a page anyone can point at any address. */
const MAX_CACHED = 500;

function cached(key: string): HolderReport | null {
  const hit = cache.get(key);
  if (!hit) return null;
  const ttl = hit.report.available ? CACHE_MS : FAILURE_CACHE_MS;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.report;
}

function remember(key: string, report: HolderReport): HolderReport {
  if (cache.size >= MAX_CACHED) {
    // Oldest first. Insertion order is good enough here; this is a cache, not a ledger.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), report });
  return report;
}

const addr = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

/**
 * Who holds what, rebuilt from the token's own Transfer log.
 *
 * `fromBlock` is the launch block. Without it there is nothing to replay from and this refuses
 * rather than guessing, because a partial replay produces balances that are simply wrong, and
 * wrong balances are worse than none.
 */
export async function holderReport(
  token: string,
  totalSupply: string | null,
  fromBlock: number | null,
  known: { curve?: string | null; creator?: string | null } = {},
): Promise<HolderReport> {
  const address = token.trim().toLowerCase();
  const total = totalSupply ? BigInt(totalSupply) : 0n;
  if (total === 0n) return unavailable("The token reports no supply.");
  if (fromBlock === null) {
    return unavailable("The launch block for this token is not known, so there is nothing to count from.");
  }

  const hit = cached(address);
  if (hit) return hit;

  let head: bigint;
  try {
    head = BigInt(await rpc<string>("eth_blockNumber", []));
  } catch {
    return remember(address, unavailable("The chain could not be reached."));
  }

  const span = head - BigInt(fromBlock);
  const windows = Number(span / WINDOW) + 1;
  if (windows > MAX_WINDOWS) {
    return remember(address, unavailable("This token is older than the holder replay reaches."));
  }

  // ── replay ───────────────────────────────────────────────────────────
  const balances = new Map<string, bigint>();
  let transfersRead = 0;

  try {
    for (let start = BigInt(fromBlock); start <= head; ) {
      const batch: [bigint, bigint][] = [];
      for (let i = 0; i < PARALLEL && start <= head; i++) {
        const to = start + WINDOW - 1n > head ? head : start + WINDOW - 1n;
        batch.push([start, to]);
        start = to + 1n;
      }

      const results = await Promise.all(
        batch.map(([from, to]) =>
          rpc<RawLog[]>("eth_getLogs", [
            {
              address,
              topics: [TRANSFER_TOPIC],
              fromBlock: `0x${from.toString(16)}`,
              toBlock: `0x${to.toString(16)}`,
            },
          ]),
        ),
      );

      for (const logs of results) {
        for (const log of logs) {
          if (log.topics.length < 3) continue;
          let value: bigint;
          try {
            value = BigInt(log.data);
          } catch {
            continue;
          }
          if (value === 0n) continue;

          const from = addr(log.topics[1]);
          const to = addr(log.topics[2]);
          if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
          balances.set(to, (balances.get(to) ?? 0n) + value);
          transfersRead++;
        }
      }

      if (transfersRead > MAX_TRANSFERS) {
        return remember(address, unavailable("This token has traded too much to count holders on the fly."));
      }
    }
  } catch (err) {
    logger.warn("tokenHolders.replay_failed", "Could not replay transfers", { err, token: address });
    return remember(address, unavailable("The chain would not serve the full transfer history."));
  }

  // ── who holds what ───────────────────────────────────────────────────
  const curve = known.curve?.toLowerCase() ?? null;
  const creator = known.creator?.toLowerCase() ?? null;

  const ranked = [...balances.entries()]
    .filter(([a, v]) => v > 0n && a !== ZERO)
    .sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));

  const label = (a: string): Holder["label"] =>
    a === curve ? "bonding curve" : a === DEAD ? "burned" : a === creator ? "creator" : null;

  const holders: Holder[] = ranked.slice(0, 10).map(([a, v]) => ({
    address: a,
    balance: v.toString(),
    share: Number((v * 10_000n) / total) / 10_000,
    label: label(a),
  }));

  // The curve holds whatever has not been bought and the dead address holds what is gone. Counting
  // either as concentration would make an untraded token look like one wallet owns everything.
  const realTop = ranked
    .filter(([a]) => a !== curve && a !== DEAD)
    .slice(0, 10)
    .reduce((sum, [, v]) => sum + v, 0n);

  return remember(address, {
    available: true,
    reason: null,
    holders,
    holderCount: ranked.filter(([a]) => a !== DEAD).length,
    transfersRead,
    topTenShare: Number((realTop * 10_000n) / total) / 10_000,
  });
}

/** Drop everything remembered. For tests, and for anything that needs a guaranteed fresh read. */
export function clearHolderCache(): void {
  cache.clear();
}
