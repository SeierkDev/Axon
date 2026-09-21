// Who launched a token, and what else they have launched.
//
// This is the question no explorer on Robinhood Chain will answer. State is pruned after about a
// thousand blocks, so you cannot ask the chain who deployed something an hour ago, and Blockscout
// refuses API traffic from servers. The answer exists only in the launchpad factory's own logs.
//
// Reading them is awkward on purpose: blocks come every tenth of a second, the node caps a query
// at a hundred thousand blocks, and the chain does around twenty thousand launches a day. So the
// window you are allowed to ask about is under three hours wide, and finding a token from last
// week means walking back through dozens of them.
//
// The saving grace is that a window contains every launch, not just the one being looked for.
// Scanning for one token therefore indexes a few thousand others for free, and the second lookup
// costs nothing. Nothing runs on a schedule: the table fills as people ask questions of it.

import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { withRpc } from "./evm";
import { logger } from "./logger";

/** Pons v2 on Robinhood Chain. Every launch on the chain passes through it. */
export const LAUNCHPAD_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e".toLowerCase();

/**
 * Launch(token indexed, curve indexed, creator indexed).
 *
 * Worked out from the chain rather than an ABI: this topic carries three indexed addresses, the
 * second is a ten-kilobyte contract (the curve) and the third an ordinary wallet, and it fires
 * once per token, thousands of blocks before that token's graduation events.
 */
const LAUNCH_TOPIC = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";

/** Fires when a token reaches the curve's target and moves to a real pool. Once per token. */
const GRADUATED_TOPIC = "0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4";

/** The node's hard ceiling on a single getLogs range. */
const WINDOW = 100_000n;

/** Roughly a tenth of a second per block, so this is about a day. */
const BLOCKS_PER_DAY = 864_000n;

/** How far back a lookup is willing to walk before giving up and saying so. */
const MAX_LOOKBACK = BLOCKS_PER_DAY * 3n;

/** Windows fetched at once. The node answers 429 if pushed, and a refused window is a window
 *  that has to be asked for again, so this stays modest on purpose. */
const PARALLEL = 4;

export interface Launch {
  token: string;
  creator: string;
  curve: string;
  blockNumber: number;
  txHash: string;
  graduatedAt: number | null;
}

interface RawLog {
  topics: string[];
  transactionHash: string;
  blockNumber: string;
}

const addr = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

const rpc = <T>(method: string, params: unknown[]) => withRpc((request) => request<T>(method, params));

async function head(): Promise<bigint> {
  return BigInt(await rpc<string>("eth_blockNumber", []));
}

/**
 * One window of factory logs for a topic.
 *
 * Null on failure, never an empty array: the node rate-limits, and a 429 that came back as "no
 * launches here" would be written down as a window already read. That hole would then be
 * permanent, and every later lookup would report a wallet's history as smaller than it is.
 */
async function logsIn(from: bigint, to: bigint, topic: string): Promise<RawLog[] | null> {
  try {
    return await rpc<RawLog[]>("eth_getLogs", [
      {
        address: LAUNCHPAD_FACTORY,
        topics: [topic],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ]);
  } catch (err) {
    logger.warn("launchIndex.window_failed", "Could not read a launch window", {
      err, from: from.toString(), to: to.toString(),
    });
    return null;
  }
}

/**
 * Read one window and write down everything in it.
 *
 * Both event types are fetched, so a token that launched and graduated inside the same window is
 * recorded complete. Returns the number of launches found, or -1 when the window could not be
 * read and must be left for another attempt.
 */
async function indexWindow(from: bigint, to: bigint): Promise<number> {
  const [launches, graduations] = await Promise.all([
    logsIn(from, to, LAUNCH_TOPIC),
    logsIn(from, to, GRADUATED_TOPIC),
  ]);

  // Anything less than both halves and this window stays unread. Recording a partial result would
  // bake the gap in, because a scanned range is never revisited.
  if (launches === null || graduations === null) return -1;

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO token_launches (token, creator, curve, block_number, tx_hash, graduated_at, seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(token) DO NOTHING`,
  );
  const graduate = db.prepare(
    `UPDATE token_launches SET graduated_at = ? WHERE token = ? AND graduated_at IS NULL`,
  );
  const remember = db.prepare(
    `INSERT INTO launch_scan_ranges (from_block, to_block, scanned_at) VALUES (?, ?, ?)
     ON CONFLICT(from_block, to_block) DO NOTHING`,
  );
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const log of launches) {
      if (log.topics.length < 4) continue;
      insert.run(
        addr(log.topics[1]),
        addr(log.topics[3]),
        addr(log.topics[2]),
        Number(BigInt(log.blockNumber)),
        log.transactionHash,
        now,
      );
    }
    for (const log of graduations) {
      if (log.topics.length < 2) continue;
      graduate.run(Number(BigInt(log.blockNumber)), addr(log.topics[1]));
    }
    remember.run(Number(from), Number(to), now);
  })();

  void syncToTurso();
  return launches.length;
}

/** Windows already read, so a second lookup never pays for the same range twice. */
function alreadyScanned(from: bigint, to: bigint): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM launch_scan_ranges WHERE from_block = ? AND to_block = ? LIMIT 1`)
    .get(Number(from), Number(to));
  return Boolean(row);
}

function stored(token: string): Launch | null {
  const row = getDb()
    .prepare(
      `SELECT token, creator, curve, block_number, tx_hash, graduated_at
         FROM token_launches WHERE token = ?`,
    )
    .get(token.toLowerCase()) as
    | { token: string; creator: string; curve: string; block_number: number; tx_hash: string; graduated_at: number | null }
    | undefined;
  if (!row) return null;
  return {
    token: row.token,
    creator: row.creator,
    curve: row.curve,
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    graduatedAt: row.graduated_at,
  };
}

/**
 * Look forward from a launch for its graduation.
 *
 * findLaunch walks BACKWARDS and stops the moment it finds the launch, so it can never see an
 * event that fires after it. A token that had graduated hours ago kept reporting itself as still
 * on its curve, directly above a supply card reading 0% unsold and 100% sold.
 *
 * Filtered to the one token, so each window comes back with at most one log, and resumed from
 * wherever the last check got to rather than starting at the launch every time.
 */
async function findGraduation(launch: Launch): Promise<number | null> {
  if (launch.graduatedAt !== null) return launch.graduatedAt;

  const db = getDb();
  const row = db
    .prepare(`SELECT graduation_checked_to FROM token_launches WHERE token = ?`)
    .get(launch.token) as { graduation_checked_to: number | null } | undefined;

  const from = BigInt(Math.max(launch.blockNumber, row?.graduation_checked_to ?? 0));
  let tip: bigint;
  try {
    tip = await head();
  } catch {
    return null;
  }
  if (from >= tip) return null;

  let found: number | null = null;
  let cursor = from;
  while (cursor < tip && found === null) {
    const batch: [bigint, bigint][] = [];
    for (let i = 0; i < PARALLEL && cursor < tip; i++) {
      const to = cursor + WINDOW - 1n > tip ? tip : cursor + WINDOW - 1n;
      batch.push([cursor, to]);
      cursor = to + 1n;
    }

    const results = await Promise.all(
      batch.map(([a, b]) =>
        rpc<RawLog[]>("eth_getLogs", [
          {
            address: LAUNCHPAD_FACTORY,
            topics: [GRADUATED_TOPIC, `0x${"0".repeat(24)}${launch.token.slice(2)}`],
            fromBlock: `0x${a.toString(16)}`,
            toBlock: `0x${b.toString(16)}`,
          },
        ]).catch(() => null),
      ),
    );

    // A window that would not answer leaves the frontier where it is, or the gap becomes
    // permanent the same way an unread launch window would.
    let reachedCleanly = true;
    for (const logs of results) {
      if (logs === null) { reachedCleanly = false; continue; }
      for (const log of logs) {
        const at = Number(BigInt(log.blockNumber));
        if (found === null || at < found) found = at;
      }
    }
    if (!reachedCleanly) break;
  }

  try {
    if (found !== null) {
      db.prepare(`UPDATE token_launches SET graduated_at = ? WHERE token = ? AND graduated_at IS NULL`)
        .run(found, launch.token);
    }
    db.prepare(`UPDATE token_launches SET graduation_checked_to = ? WHERE token = ?`)
      .run(Number(found !== null ? found : cursor), launch.token);
    void syncToTurso();
  } catch (err) {
    logger.warn("launchIndex.graduation_not_stored", "Could not store graduation", { err });
  }

  return found;
}

export interface LookupResult {
  launch: Launch | null;
  /** how far back the walk actually got, so "not found" can be told apart from "not looked" */
  searchedToBlock: number | null;
  /** true when the lookback ran out before the launch turned up */
  gaveUp: boolean;
}

/**
 * Find a token's launch, walking back from the head until it turns up.
 *
 * Every window read on the way is written down whole, so this gets cheaper the more it is used and
 * a token that was indexed by somebody else's lookup is returned immediately.
 */
export async function findLaunch(token: string): Promise<LookupResult> {
  const wanted = token.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wanted)) throw new Error("Not an address");

  const known = stored(wanted);
  if (known) return { launch: known, searchedToBlock: known.blockNumber, gaveUp: false };

  const tip = await head();
  const floor = tip > MAX_LOOKBACK ? tip - MAX_LOOKBACK : 0n;
  let cursor = tip;

  while (cursor > floor) {
    // A batch of windows at a time: sequential round trips over a day of blocks would take
    // longer than anyone will wait for a page.
    const batch: [bigint, bigint][] = [];
    for (let i = 0; i < PARALLEL && cursor > floor; i++) {
      const to = cursor;
      const from = cursor > WINDOW ? cursor - WINDOW + 1n : 0n;
      if (!alreadyScanned(from, to)) batch.push([from, to]);
      cursor = from - 1n;
    }

    if (batch.length > 0) {
      await Promise.all(batch.map(([from, to]) => indexWindow(from, to)));
      const found = stored(wanted);
      if (found) return { launch: found, searchedToBlock: found.blockNumber, gaveUp: false };
    }
  }

  return { launch: null, searchedToBlock: Number(floor), gaveUp: true };
}

export interface CreatorHistory {
  creator: string;
  /** every launch by this wallet that has been indexed, newest first */
  launches: Launch[];
  total: number;
  graduated: number;
  /** the oldest block any lookup has read, so the page can say what this count is out of */
  indexedFromBlock: number | null;
}

/**
 * What else this wallet has launched, out of everything indexed so far.
 *
 * Deliberately only reports what has actually been read. A wallet with no other launches in the
 * index might have a hundred older ones, and saying "1 launch" would be a claim the data does not
 * support. `indexedFromBlock` is how the page says how far back the count goes.
 */
export function creatorHistory(creator: string, limit = 50): CreatorHistory {
  const who = creator.trim().toLowerCase();
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT token, creator, curve, block_number, tx_hash, graduated_at
         FROM token_launches WHERE creator = ? ORDER BY block_number DESC LIMIT ?`,
    )
    .all(who, limit) as {
      token: string; creator: string; curve: string;
      block_number: number; tx_hash: string; graduated_at: number | null;
    }[];

  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(graduated_at) AS graduated
         FROM token_launches WHERE creator = ?`,
    )
    .get(who) as { total: number; graduated: number };

  const range = db
    .prepare(`SELECT MIN(from_block) AS floor FROM launch_scan_ranges`)
    .get() as { floor: number | null };

  return {
    creator: who,
    launches: rows.map((r) => ({
      token: r.token,
      creator: r.creator,
      curve: r.curve,
      blockNumber: r.block_number,
      txHash: r.tx_hash,
      graduatedAt: r.graduated_at,
    })),
    total: counts.total,
    graduated: counts.graduated,
    indexedFromBlock: range.floor,
  };
}

/** Everything known about who is behind a token, for the page to render. */
export interface DeployerReport {
  launch: Launch | null;
  gaveUp: boolean;
  history: CreatorHistory | null;
}

export async function deployerReport(token: string): Promise<DeployerReport> {
  const { launch, gaveUp } = await findLaunch(token);
  if (!launch) return { launch: null, gaveUp, history: null };

  // The backward walk cannot have seen this, so ask forwards before anything renders "still on
  // the curve" over a curve that emptied hours ago.
  const graduatedAt = await findGraduation(launch);

  return {
    launch: { ...launch, graduatedAt },
    gaveUp,
    history: creatorHistory(launch.creator),
  };
}
