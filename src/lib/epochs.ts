// Phase 10 (10.8): Axon World epochs.
//
// The world's "seasons": fixed 7-day windows, deterministic from a genesis
// timestamp, over which we tally each agent's REAL network activity (tasks
// completed + USDC settled in the window) into a non-monetary "score" and a
// leaderboard. This is read-only analytics on live data — it moves no funds and
// mints no token. Any actual $AXON reward layer is deliberately NOT built here;
// it stays behind a disabled flag pending a rewards-model + regulatory decision.
//
// Because the score is driven by settled on-chain USDC and completed tasks (both
// already backed by real payments), it's inherently expensive to game — you'd
// have to actually pay agents to inflate it.

import { getDb } from "./db";
import { isContractTestAgent } from "./agents";

const GENESIS = Date.parse("2026-01-05T00:00:00Z"); // a Monday
const EPOCH_MS = 7 * 24 * 3_600_000;
const TASK_WEIGHT = 10; // score points per completed task
const LEADERBOARD_SIZE = 50;

export interface EpochStanding {
  agentId: string;
  name: string;
  score: number;
  tasks: number;
  usdc: number;
  rank: number;
}

export interface EpochSnapshot {
  index: number;
  startsAt: string;
  endsAt: string;
  msRemaining: number;
  totals: { tasks: number; usdc: number; agents: number };
  leaderboard: EpochStanding[];
  generatedAt: string;
}

function computeEpoch(now: number): EpochSnapshot {
  const index = Math.max(0, Math.floor((now - GENESIS) / EPOCH_MS));
  const startMs = GENESIS + index * EPOCH_MS;
  const endMs = startMs + EPOCH_MS;
  const startsAt = new Date(startMs).toISOString();
  const endsAt = new Date(endMs).toISOString();

  const db = getDb();
  const taskRows = db
    .prepare(
      `SELECT to_agent AS agent, COUNT(*) AS tasks
       FROM tasks
       WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?
       GROUP BY to_agent`
    )
    .all(startsAt, endsAt) as { agent: string; tasks: number }[];
  const usdcRows = db
    .prepare(
      `SELECT to_agent AS agent, SUM(amount_sol) AS usdc
       FROM transactions
       WHERE status = 'completed' AND currency = 'USDC'
         AND COALESCE(settled_at, created_at) >= ? AND COALESCE(settled_at, created_at) < ?
       GROUP BY to_agent`
    )
    .all(startsAt, endsAt) as { agent: string; usdc: number | null }[];
  const nameRows = db.prepare(`SELECT agent_id, name FROM agents`).all() as { agent_id: string; name: string }[];
  const names = new Map(nameRows.map((r) => [r.agent_id, r.name]));

  const acc = new Map<string, { tasks: number; usdc: number }>();
  const bump = (agent: string, tasks: number, usdc: number) => {
    if (!agent || isContractTestAgent(agent) || !names.has(agent)) return;
    const e = acc.get(agent) ?? { tasks: 0, usdc: 0 };
    e.tasks += tasks;
    e.usdc += usdc;
    acc.set(agent, e);
  };
  for (const r of taskRows) bump(r.agent, r.tasks, 0);
  for (const r of usdcRows) bump(r.agent, 0, r.usdc ?? 0);

  const ranked = [...acc.entries()]
    .map(([agentId, e]) => ({
      agentId,
      name: names.get(agentId) ?? agentId,
      tasks: e.tasks,
      usdc: Math.round(e.usdc * 1_000_000) / 1_000_000,
      score: Math.round((e.tasks * TASK_WEIGHT + e.usdc) * 1000) / 1000,
    }))
    .sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));

  const leaderboard: EpochStanding[] = ranked
    .slice(0, LEADERBOARD_SIZE)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  const totals = {
    tasks: ranked.reduce((s, r) => s + r.tasks, 0),
    usdc: Math.round(ranked.reduce((s, r) => s + r.usdc, 0) * 1_000_000) / 1_000_000,
    agents: ranked.length,
  };

  return {
    index,
    startsAt,
    endsAt,
    msRemaining: Math.max(0, endMs - now),
    totals,
    leaderboard,
    generatedAt: new Date(now).toISOString(),
  };
}

// Memoize briefly so polling doesn't re-run the aggregate every request.
const CACHE_MS = process.env.VITEST ? 0 : 30_000;
let cache: { at: number; snapshot: EpochSnapshot } | null = null;

export function getEpochSnapshot(): EpochSnapshot {
  const now = Date.now();
  if (CACHE_MS > 0 && cache && now - cache.at < CACHE_MS) return cache.snapshot;
  const snapshot = computeEpoch(now);
  cache = { at: now, snapshot };
  return snapshot;
}

export function _clearEpochCache(): void {
  cache = null;
}
