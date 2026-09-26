// Noticing a stolen allowance key.
//
// The one real risk in allowances: whoever holds an allowance key can spend up to its daily limit on
// an agent they control. Nothing on chain can tell a thief from the owner, since both hold a valid
// key. What differs is the shape of the spending, so these read the shape and say so:
//
//   new_agent   paying an agent that was registered less than a day before the hire. A thief's
//               agent is usually minutes old; the agents an owner means to use have a history.
//   burst       many hires in a few minutes, or most of a day's limit inside an hour. A thief wants
//               the money out before anyone looks.
//   one_payee   most of today's spending going to a single agent this wallet had never paid before
//               today.
//
// Warnings, not refusals. Each of these also describes legitimate use now and then, and refusing it
// would break the owner's own assistant at the moment they are relying on it. The hard limits stay
// where they were (the key's own, and the contract's); these put the pattern in front of the owner,
// on the dashboard next to the key and its Revoke button.

import { getDb } from "./db";
import { formatEth } from "./money";
import { logger } from "./logger";
import { getKeyLimits } from "./allowanceKeys";
import { utcDay } from "./allowancePolicy";

export const NEW_AGENT_HOURS = 24;
export const BURST_HIRES = 5;
export const BURST_MINUTES = 10;
/** Share of the key's daily limit that, spent inside an hour, reads as draining rather than working. */
export const FAST_SPEND_SHARE = 0.8;
export const ONE_PAYEE_SHARE = 0.8;

export type WarningCode = "new_agent" | "burst" | "one_payee";

export interface KeyWarning {
  code: WarningCode;
  message: string;
}

interface Hire {
  task_id: string;
  created_at: string;
  eth_wei: string | null;
  state: string;
  to_agent: string | null;
  agent_created_at: string | null;
}

/** What looks wrong about this key's recent spending, in words for its owner. Empty when nothing does. */
export function keyWarnings(keyId: string, nowMs = Date.now()): KeyWarning[] {
  const db = getDb();
  const dayStart = new Date(utcDay(nowMs / 1000) * 86_400_000).toISOString();
  const since = new Date(Math.min(Date.parse(dayStart), nowMs - 3_600_000)).toISOString();

  // Released and reclaimed work cost nothing, so it is not spending. Its shape still counts toward a
  // burst, since a thief firing hires at agents that fail is still firing them.
  const hires = db.prepare(`
    SELECT r.task_id, r.created_at, r.eth_wei, r.state, t.to_agent, a.created_at AS agent_created_at
    FROM allowance_reservations r
    LEFT JOIN tasks t ON t.task_id = r.task_id
    LEFT JOIN agents a ON a.agent_id = t.to_agent
    WHERE r.api_key_id = ? AND r.created_at >= ?
    ORDER BY r.created_at
  `).all(keyId, since) as Hire[];
  if (hires.length === 0) return [];

  const warnings: KeyWarning[] = [];
  const spent = (h: Hire) => (h.state === "reserved" || h.state === "settled") && h.eth_wei ? BigInt(h.eth_wei) : 0n;

  // new_agent
  const young = [...new Set(hires
    .filter((h) => h.to_agent && h.agent_created_at &&
      Date.parse(h.created_at) - Date.parse(h.agent_created_at) < NEW_AGENT_HOURS * 3_600_000)
    .map((h) => h.to_agent!))];
  if (young.length > 0) {
    warnings.push({
      code: "new_agent",
      message: `Paid ${young.join(", ")}, registered less than ${NEW_AGENT_HOURS} hours before the hire`,
    });
  }

  // burst: count, or value
  const recent = hires.filter((h) => nowMs - Date.parse(h.created_at) <= BURST_MINUTES * 60_000);
  const limits = getKeyLimits(keyId);
  const lastHour = hires.filter((h) => nowMs - Date.parse(h.created_at) <= 3_600_000).reduce((s, h) => s + spent(h), 0n);
  const fastCap = limits ? (limits.maxPerDayWei * BigInt(Math.round(FAST_SPEND_SHARE * 100))) / 100n : null;
  if (recent.length >= BURST_HIRES) {
    warnings.push({ code: "burst", message: `${recent.length} hires in the last ${BURST_MINUTES} minutes` });
  } else if (fastCap !== null && fastCap > 0n && lastHour >= fastCap) {
    warnings.push({
      code: "burst",
      message: `${formatEth(lastHour)} spent in the last hour, most of its ${formatEth(limits!.maxPerDayWei)} daily limit`,
    });
  }

  // one_payee: most of today's spending to an agent this wallet first paid today. Only for a wallet
  // with a history: on somebody's first day every agent is one they never paid before, and flagging
  // that told every new user their own first hires looked like theft.
  const today = hires.filter((h) => h.created_at >= dayStart);
  const ownerRow = db.prepare("SELECT owner FROM allowance_reservations WHERE api_key_id = ? LIMIT 1").get(keyId) as
    { owner: string } | undefined;
  const hasHistory = ownerRow
    ? Boolean(db.prepare("SELECT 1 FROM allowance_reservations WHERE owner = ? AND created_at < ? LIMIT 1").get(ownerRow.owner, dayStart))
    : false;
  const todayTotal = today.reduce((s, h) => s + spent(h), 0n);
  if (todayTotal > 0n && hasHistory) {
    const byAgent = new Map<string, bigint>();
    for (const h of today) if (h.to_agent) byAgent.set(h.to_agent, (byAgent.get(h.to_agent) ?? 0n) + spent(h));
    const [top, amount] = [...byAgent.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] ?? [];
    if (top && amount * 100n >= todayTotal * BigInt(Math.round(ONE_PAYEE_SHARE * 100)) && today.length >= 2) {
      const paidBefore = ownerRow && db.prepare(`
        SELECT 1 FROM allowance_reservations r JOIN tasks t ON t.task_id = r.task_id
        WHERE r.owner = ? AND t.to_agent = ? AND r.created_at < ? LIMIT 1
      `).get(ownerRow.owner, top, dayStart);
      if (!paidBefore) {
        warnings.push({
          code: "one_payee",
          message: `Most of today's spending went to ${top}, an agent this wallet had never paid before today`,
        });
      }
    }
  }

  return warnings;
}

/** The warnings already reported, so each is logged once per key per day rather than per hire. */
const reported = new Set<string>();

/** After a hire: log any new warning for this key, once per key, code and day. */
export function noteAllowanceHire(keyId: string, nowMs = Date.now()): KeyWarning[] {
  const warnings = keyWarnings(keyId, nowMs);
  const day = utcDay(nowMs / 1000);
  for (const w of warnings) {
    const mark = `${keyId}:${w.code}:${day}`;
    if (reported.has(mark)) continue;
    reported.add(mark);
    logger.warn("allowance.unusual_spend", "An allowance key is spending in a way that can mean it was stolen", {
      keyId, code: w.code, detail: w.message,
    });
  }
  return warnings;
}

/** Per-key hire rate: generous for an assistant working, tight for a script draining. */
export const KEY_HIRES_PER_MINUTE = 10;
