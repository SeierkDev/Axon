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
    cache = { at: Date.now(), rows };
    return rows.slice(0, limit);
  } catch (err) {
    logger.warn("burn.history_unreadable", "Could not read burn history", { err, pot });
    return [];
  }
}
