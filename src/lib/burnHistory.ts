// The individual burns, each with the transaction that did it.
//
// The page could say how much had burned in total and link the pot, which tells you the balance
// is real but not that any particular burn happened. Somebody reading a post about burn #4 had no
// way to get from that claim to the transaction behind it.
//
// This reads the pot's own Burned events, so every row on the page is a receipt: what went in,
// what came out, and a hash anyone can open on the explorer.

import { decodeEventLog, parseAbiItem } from "viem";
import { getLogs, blockNumber } from "./evm";
import { burnPotAddress } from "./burn";
import { weiToEth } from "./money";
import { EXPLORER } from "./chain";
import { logger } from "./logger";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";

const BURNED = parseAbiItem(
  "event Burned(uint256 indexed n, address indexed caller, uint256 ethIn, uint256 tokensOut, bool viaCurve, uint256 day)",
);

/**
 * How far back to look.
 *
 * Robinhood Chain produces blocks about every tenth of a second, so a day is roughly 864,000
 * blocks and the node refuses a query spanning more than 100,000. Burns are thirty minutes apart,
 * so 300,000 blocks is around eight hours and a dozen or so burns: enough for a "recent burns"
 * list without walking the whole chain on every page load.
 */
const LOOKBACK_BLOCKS = 300_000n;

export interface BurnRecord {
  n: number;
  ethIn: number;
  tokensOut: number;
  txHash: string;
  blockNumber: number;
  /** who paid the gas. The engine for most, anyone at all for the rest. */
  caller: string;
  explorer: string;
}

let cache: { at: number; rows: BurnRecord[] } | null = null;
const CACHE_MS = 30_000;

/** Write down any burn we have not seen before. The pot's own number is the key, so a burn read
 *  twice is stored once and a re-read can never duplicate or reorder the history. */
function remember(rows: BurnRecord[]): void {
  if (rows.length === 0) return;
  try {
    const db = getDb();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO burns (n, tx_hash, block_number, eth_in, tokens_out, caller, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    let added = 0;
    db.transaction(() => {
      for (const r of rows) {
        added += insert.run(r.n, r.txHash, r.blockNumber, r.ethIn, r.tokensOut, r.caller, now).changes;
      }
    })();
    if (added > 0) syncToTurso();
  } catch (err) {
    // Remembering is a convenience. Never let it stop the page rendering what the chain just said.
    logger.warn("burn.history_not_stored", "Could not store burn history", { err });
  }
}

/**
 * Walk back through older blocks for burns that were never written down.
 *
 * The archive only holds what was seen while the page was being looked at, so the earliest burns are
 * missing: this pot had already fired eleven times before anything started recording them. Those rows
 * are not lost, they are just further back in the log than a single query may reach.
 *
 * Each pass reads one window below whatever is already known and stores what it finds. It is meant to be
 * called when somebody actually pages back that far, rather than on a schedule, and it stops as soon as
 * it reaches burn number one because there is nothing before that.
 */
export async function backfillOlderBurns(windows = 4): Promise<{ added: number; reachedStart: boolean }> {
  const pot = burnPotAddress();
  if (!pot) return { added: 0, reachedStart: false };

  const range = storedBurnRange();
  if (range.lowest === 1) return { added: 0, reachedStart: true };

  // Start below the oldest burn we hold, or below the head if we hold nothing at all.
  let cursor: bigint;
  try {
    const oldest = range.lowest === null ? null : oldestStoredBlock();
    cursor = oldest !== null ? BigInt(oldest) - 1n : await blockNumber();
  } catch {
    return { added: 0, reachedStart: false };
  }

  let added = 0;
  for (let i = 0; i < windows && cursor > 0n; i++) {
    const from = cursor > LOOKBACK_BLOCKS ? cursor - LOOKBACK_BLOCKS : 0n;
    try {
      const logs = (await getLogs(from, cursor, {
        address: pot,
        topics: ["0xe81ef1f1bb6c6c1fa367c0da723b5ec328ab8225dbfff726273a8fce586fe2db"],
      })) as { topics: string[]; data: string; transactionHash: string; blockNumber: string }[];

      const rows: BurnRecord[] = [];
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({
            abi: [BURNED],
            topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
            data: log.data as `0x${string}`,
          });
          const a = decoded.args as unknown as { n: bigint; caller: string; ethIn: bigint; tokensOut: bigint };
          rows.push({
            n: Number(a.n),
            ethIn: weiToEth(a.ethIn),
            tokensOut: weiToEth(a.tokensOut),
            txHash: log.transactionHash,
            blockNumber: Number(BigInt(log.blockNumber)),
            caller: a.caller.toLowerCase(),
            explorer: `${EXPLORER}/tx/${log.transactionHash}`,
          });
        } catch { /* a log that will not decode is not worth failing the walk over */ }
      }

      const before = storedBurnRange().count;
      remember(rows);
      added += storedBurnRange().count - before;
    } catch (err) {
      logger.warn("burn.backfill_window_failed", "Could not read an older burn window", { err });
      break;
    }
    cursor = from === 0n ? 0n : from - 1n;
  }

  // The cache holds a merged view that no longer matches the table.
  cache = null;
  return { added, reachedStart: storedBurnRange().lowest === 1 };
}

/** The block of the oldest burn we hold, which is where a walk backwards starts. */
function oldestStoredBlock(): number | null {
  try {
    const r = getDb().prepare(`SELECT MIN(block_number) AS b FROM burns`).get() as { b: number | null } | undefined;
    return r?.b ?? null;
  } catch {
    return null;
  }
}

/**
 * A page of the archive, newest first, ending before burn `before`.
 *
 * The page used to show ten and stop. Eighty three burns had happened by then, so "every burn" was a
 * heading over the last nine of them and there was no way to reach the rest. A burn somebody read about
 * yesterday was already unreachable, which is the opposite of what a receipt is for.
 */
export function burnPage(limit = 20, before?: number): { burns: BurnRecord[]; hasMore: boolean } {
  try {
    const db = getDb();
    // One extra row answers "is there more" without a second count query.
    const rows = db
      .prepare(
        `SELECT n, tx_hash, block_number, eth_in, tokens_out, caller
           FROM burns
          WHERE (? IS NULL OR n < ?)
          ORDER BY n DESC
          LIMIT ?`,
      )
      .all(before ?? null, before ?? null, limit + 1) as {
        n: number; tx_hash: string; block_number: number;
        eth_in: number; tokens_out: number; caller: string;
      }[];

    const hasMore = rows.length > limit;
    return {
      hasMore,
      burns: rows.slice(0, limit).map((r) => ({
        n: r.n,
        ethIn: r.eth_in,
        tokensOut: r.tokens_out,
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        caller: r.caller,
        explorer: `${EXPLORER}/tx/${r.tx_hash}`,
      })),
    };
  } catch {
    return { burns: [], hasMore: false };
  }
}

/** How many burns are written down, and the lowest number among them. */
export function storedBurnRange(): { count: number; lowest: number | null } {
  try {
    const r = getDb().prepare(`SELECT COUNT(*) AS c, MIN(n) AS lo FROM burns`).get() as
      | { c: number; lo: number | null }
      | undefined;
    return { count: r?.c ?? 0, lowest: r?.lo ?? null };
  } catch {
    return { count: 0, lowest: null };
  }
}

/** Everything written down so far, newest first. */
function stored(limit: number): BurnRecord[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT n, tx_hash, block_number, eth_in, tokens_out, caller
           FROM burns ORDER BY n DESC LIMIT ?`,
      )
      .all(limit) as {
        n: number; tx_hash: string; block_number: number;
        eth_in: number; tokens_out: number; caller: string;
      }[];
    return rows.map((r) => ({
      n: r.n,
      ethIn: r.eth_in,
      tokensOut: r.tokens_out,
      txHash: r.tx_hash,
      blockNumber: r.block_number,
      caller: r.caller,
      explorer: `${EXPLORER}/tx/${r.tx_hash}`,
    }));
  } catch {
    return [];
  }
}

/**
 * The most recent burns, newest first.
 *
 * Returns an empty list rather than throwing when there is no pot, or when the node will not
 * answer: a burn page missing its receipts is worse than the page, but far better than no page.
 */
export async function recentBurns(limit = 10): Promise<BurnRecord[]> {
  const pot = burnPotAddress();
  if (!pot) return [];
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows.slice(0, limit);

  try {
    const head = await blockNumber();
    const from = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    const logs = (await getLogs(from, head, {
      address: pot,
      topics: [
        // keccak of the event signature; the indexed args are left open
        "0xe81ef1f1bb6c6c1fa367c0da723b5ec328ab8225dbfff726273a8fce586fe2db",
      ],
    })) as { topics: string[]; data: string; transactionHash: string; blockNumber: string }[];

    const rows: BurnRecord[] = [];
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: [BURNED],
          topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
          data: log.data as `0x${string}`,
        });
        const a = decoded.args as unknown as {
          n: bigint; caller: string; ethIn: bigint; tokensOut: bigint;
        };
        rows.push({
          n: Number(a.n),
          ethIn: weiToEth(a.ethIn),
          tokensOut: weiToEth(a.tokensOut),
          txHash: log.transactionHash,
          blockNumber: Number(BigInt(log.blockNumber)),
          caller: a.caller.toLowerCase(),
          explorer: `${EXPLORER}/tx/${log.transactionHash}`,
        });
      } catch {
        // A log that will not decode is not worth failing the list over.
      }
    }

    rows.sort((x, y) => y.n - x.n);
    remember(rows);

    // The chain answers for the last few hours; the table answers for everything before that.
    // Merged on the pot's own burn number, so the two can never disagree about a given burn.
    const merged = new Map<number, BurnRecord>();
    for (const r of stored(limit + rows.length)) merged.set(r.n, r);
    for (const r of rows) merged.set(r.n, r);
    const all = [...merged.values()].sort((x, y) => y.n - x.n);

    cache = { at: Date.now(), rows: all };
    return all.slice(0, limit);
  } catch (err) {
    // A node that will not answer is not a reason to show nothing: everything seen before is here.
    logger.warn("burn.history_unreadable", "Could not read burn history from chain", { err, pot });
    return stored(limit);
  }
}
