// Phase 10 (10.1): Axon Open World — the data → world model bridge.
//
// Turns live network state into a *city model* that the 3D world renders: every
// registered agent becomes a building plot, grouped into districts by capability
// category, sized/lit by real metrics (USDC earned, task throughput, reputation,
// recent activity). The layout is DETERMINISTIC — a stable hash of the agent's
// position in its district maps to fixed world coordinates, so the city looks the
// same on every load and new agents slot into open lots without reshuffling the
// existing skyline.
//
// This module renders nothing; it only computes the model. The R3F world (10.2)
// consumes the snapshot and draws it.

import { getDb } from "./db";
import { isContractTestAgent } from "./agents";

export interface WorldPlot {
  agentId: string;
  name: string;
  district: string; // capability category
  x: number; // world coordinates (metres), city centred on origin
  z: number;
  size: number; // building footprint scale, from USDC earned
  height: number; // building height, from task throughput
  reputation: number; // raw reputation score
  reputationNorm: number; // 0..1 within this snapshot, for glow intensity
  active: boolean; // completed a task in the last 24h → lights on
  tasksCompleted: number;
  usdcEarned: number;
  verified: boolean;
  walletAddress: string | null;
}

export interface WorldDistrict {
  name: string;
  agentCount: number;
  // Centre of the district's footprint, for labels / minimap.
  centerX: number;
  centerZ: number;
}

export interface WorldTotals {
  agents: number;
  districts: number;
  totalUsdcEarned: number;
  totalTasksCompleted: number;
  activeAgents: number;
}

// The week's busiest agents — they staff the plaza market stalls in the world.
export interface WeeklyTopAgent {
  agentId: string;
  name: string;
  price: string | null; // listed terms, e.g. "0.25 USDC"
  tasks7d: number;
}

export interface WorldSnapshot {
  totals: WorldTotals;
  districts: WorldDistrict[];
  plots: WorldPlot[];
  // Undirected pairs of agents that have transacted ("neighbors"), for drawing
  // roads between their buildings in the world.
  edges: [string, string][];
  weeklyTop: WeeklyTopAgent[];
  generatedAt: string;
}

// ── Layout constants ──────────────────────────────────────────────────────────
// Distance between adjacent plot centres within a district.
const PLOT_SPACING = 16;
// Empty margin (in plot-spacings) reserved around each district so neighbouring
// districts never touch.
const DISTRICT_MARGIN = 1.5;

interface AgentRow {
  agent_id: string;
  name: string;
  category: string;
  reputation: number;
  wallet_address: string | null;
  verification_status: string;
  tasks_completed: number;
  tasks_recent: number;
  usdc_earned: number;
}

// Map a metric to a building dimension on a gentle log curve so a few whales
// don't dwarf everyone — the city stays readable.
function scaleSize(usdc: number): number {
  return Math.min(4, 1 + Math.log10(1 + Math.max(0, usdc)) / 2);
}
function scaleHeight(tasks: number): number {
  return Math.min(24, 3 + Math.log10(1 + Math.max(0, tasks)) * 4);
}

function computeSnapshot(): WorldSnapshot {
  const cutoff24h = new Date(Date.now() - 24 * 3_600_000).toISOString();

  // One pass: every agent with its earnings (completed USDC settlements) and task
  // throughput (all-time + last 24h). Ordered category → created_at → agent_id so
  // a given agent always lands in the same district slot, and newer agents append
  // after older ones without disturbing existing positions.
  const rows = getDb()
    .prepare(
      `SELECT
         a.agent_id, a.name, a.category, a.reputation, a.wallet_address, a.verification_status,
         COALESCE(t.completed, 0) AS tasks_completed,
         COALESCE(t.recent, 0)    AS tasks_recent,
         COALESCE(x.usdc, 0)      AS usdc_earned
       FROM agents a
       LEFT JOIN (
         SELECT to_agent,
                COUNT(*) FILTER (WHERE status = 'completed')                       AS completed,
                COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= ?)  AS recent
         FROM tasks GROUP BY to_agent
       ) t ON t.to_agent = a.agent_id
       LEFT JOIN (
         SELECT to_agent,
                SUM(amount_sol) FILTER (WHERE status = 'completed' AND currency = 'USDC') AS usdc
         FROM transactions GROUP BY to_agent
       ) x ON x.to_agent = a.agent_id
       ORDER BY a.category ASC, a.created_at ASC, a.agent_id ASC`
    )
    .all(cutoff24h) as AgentRow[];

  // Drop contract-test artifacts — they're not real network participants.
  const agents = rows.filter((r) => !isContractTestAgent(r.agent_id));

  // Group into districts (preserving the stable ordering above).
  const byDistrict = new Map<string, AgentRow[]>();
  for (const a of agents) {
    const arr = byDistrict.get(a.category);
    if (arr) arr.push(a);
    else byDistrict.set(a.category, [a]);
  }
  const districtNames = [...byDistrict.keys()].sort();

  // Uniform coarse cells: every district occupies a square cell sized to the
  // largest district, so cells can't overlap regardless of how lopsided the
  // category distribution is. Districts are packed into a square-ish coarse grid.
  let maxInner = 1;
  for (const name of districtNames) {
    const count = byDistrict.get(name)!.length;
    maxInner = Math.max(maxInner, Math.ceil(Math.sqrt(count)));
  }
  const cellSpan = (maxInner - 1) * PLOT_SPACING; // distance across plots in a cell
  const cellSize = cellSpan + DISTRICT_MARGIN * 2 * PLOT_SPACING;
  const districtCols = Math.max(1, Math.ceil(Math.sqrt(districtNames.length)));
  const districtRows = Math.max(1, Math.ceil(districtNames.length / districtCols));

  // Offsets that recentre the whole city on the origin.
  const cityCenterX = ((districtCols - 1) * cellSize) / 2;
  const cityCenterZ = ((districtRows - 1) * cellSize) / 2;

  const maxReputation = agents.reduce((m, a) => Math.max(m, a.reputation), 0);

  const plots: WorldPlot[] = [];
  const districts: WorldDistrict[] = [];

  districtNames.forEach((name, di) => {
    const members = byDistrict.get(name)!;
    const dcol = di % districtCols;
    const drow = Math.floor(di / districtCols);
    const districtOriginX = dcol * cellSize - cityCenterX;
    const districtOriginZ = drow * cellSize - cityCenterZ;

    // Inner grid for this district's agents, centred within the cell.
    const innerCols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const innerRows = Math.max(1, Math.ceil(members.length / innerCols));
    const innerOffsetX = ((innerCols - 1) * PLOT_SPACING) / 2;
    const innerOffsetZ = ((innerRows - 1) * PLOT_SPACING) / 2;

    members.forEach((a, j) => {
      const icol = j % innerCols;
      const irow = Math.floor(j / innerCols);
      const x = districtOriginX + icol * PLOT_SPACING - innerOffsetX;
      const z = districtOriginZ + irow * PLOT_SPACING - innerOffsetZ;
      plots.push({
        agentId: a.agent_id,
        name: a.name,
        district: name,
        x: Math.round(x * 100) / 100,
        z: Math.round(z * 100) / 100,
        size: Math.round(scaleSize(a.usdc_earned) * 1000) / 1000,
        height: Math.round(scaleHeight(a.tasks_completed) * 1000) / 1000,
        reputation: a.reputation,
        reputationNorm: maxReputation > 0 ? Math.round((a.reputation / maxReputation) * 1000) / 1000 : 0,
        active: a.tasks_recent > 0,
        tasksCompleted: a.tasks_completed,
        usdcEarned: Math.round(a.usdc_earned * 1_000_000) / 1_000_000,
        // "verified" isn't a real status (valid: platform/x402_compliant/
        // reachable/unreachable) — the old check made EVERY house unverified.
        verified: a.verification_status === "platform" || a.verification_status === "x402_compliant",
        walletAddress: a.wallet_address,
      });
    });

    districts.push({
      name,
      agentCount: members.length,
      centerX: Math.round((districtOriginX) * 100) / 100,
      centerZ: Math.round((districtOriginZ) * 100) / 100,
    });
  });

  const totals: WorldTotals = {
    agents: agents.length,
    districts: districtNames.length,
    totalUsdcEarned: Math.round(agents.reduce((s, a) => s + a.usdc_earned, 0) * 1_000_000) / 1_000_000,
    totalTasksCompleted: agents.reduce((s, a) => s + a.tasks_completed, 0),
    activeAgents: agents.reduce((s, a) => s + (a.tasks_recent > 0 ? 1 : 0), 0),
  };

  // Neighbor edges — distinct undirected pairs of real agents that have
  // transacted with each other. Capped so a hub agent can't explode the payload.
  const idSet = new Set(agents.map((a) => a.agent_id));
  const pairRows = getDb()
    .prepare(
      `SELECT DISTINCT from_agent, to_agent FROM transactions
       WHERE from_agent IS NOT NULL AND to_agent IS NOT NULL AND from_agent <> to_agent`
    )
    .all() as { from_agent: string; to_agent: string }[];
  const seenEdge = new Set<string>();
  const edges: [string, string][] = [];
  for (const r of pairRows) {
    if (!idSet.has(r.from_agent) || !idSet.has(r.to_agent)) continue;
    const a = r.from_agent < r.to_agent ? r.from_agent : r.to_agent;
    const b = r.from_agent < r.to_agent ? r.to_agent : r.from_agent;
    const key = `${a}|${b}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push([a, b]);
    if (edges.length >= 400) break;
  }

  // Weekly top — who moved the most work in the last 7 days. They get the
  // market stalls on the plaza.
  const cutoff7d = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const weeklyRows = getDb()
    .prepare(
      `SELECT t.to_agent AS agent_id, a.name, a.price, COUNT(*) AS tasks_7d
       FROM tasks t JOIN agents a ON a.agent_id = t.to_agent
       WHERE t.status = 'completed' AND t.completed_at >= ?
       GROUP BY t.to_agent ORDER BY tasks_7d DESC, t.to_agent ASC LIMIT 6`,
    )
    .all(cutoff7d) as { agent_id: string; name: string; price: string | null; tasks_7d: number }[];
  const weeklyTop: WeeklyTopAgent[] = weeklyRows
    .filter((r) => !isContractTestAgent(r.agent_id))
    .slice(0, 3)
    .map((r) => ({ agentId: r.agent_id, name: r.name, price: r.price, tasks7d: r.tasks_7d }));

  return { totals, districts, plots, edges, weeklyTop, generatedAt: new Date().toISOString() };
}

// Memoize so polling / many concurrent canvases don't re-run the aggregate query
// every frame. Disabled under tests so each case sees fresh data.
const CACHE_MS = process.env.VITEST ? 0 : 15_000;
let cache: { at: number; snapshot: WorldSnapshot } | null = null;

export function getWorldSnapshot(): WorldSnapshot {
  if (CACHE_MS > 0 && cache && Date.now() - cache.at < CACHE_MS) return cache.snapshot;
  const snapshot = computeSnapshot();
  cache = { at: Date.now(), snapshot };
  return snapshot;
}

// Test seam — drop the memoized snapshot.
export function _clearWorldCache(): void {
  cache = null;
}

// ── Live agent activity (house storefront panel) ─────────────────────────────
//
// Same privacy rule as the public explorer: metadata only — statuses, counts,
// and timestamps. Task content and outputs are never exposed to the world.

export interface AgentActivity {
  running: number; // tasks being worked on right now
  queued: number; // tasks waiting in this agent's inbox
  lastCompletedAt: string | null;
  completed24h: number;
}

// ── Live network activity (task streaks) ─────────────────────────────────────
//
// The world draws a light streak from the requester's house to the worker's
// house for every task that completes. Metadata only: ids, parties, timestamp.

export interface WorldActivityEvent {
  taskId: string;
  fromAgent: string;
  toAgent: string;
  completedAt: string;
}

export function getWorldActivity(): WorldActivityEvent[] {
  // Only the recent past — a client that just loaded shouldn't replay history.
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT task_id, from_agent, to_agent, completed_at FROM tasks
       WHERE status = 'completed' AND completed_at >= ?
       ORDER BY completed_at DESC LIMIT 30`,
    )
    .all(cutoff) as { task_id: string; from_agent: string; to_agent: string; completed_at: string }[];
  return rows
    .filter((r) => !isContractTestAgent(r.from_agent) && !isContractTestAgent(r.to_agent))
    .map((r) => ({ taskId: r.task_id, fromAgent: r.from_agent, toAgent: r.to_agent, completedAt: r.completed_at }));
}

// ── Framed receipts (house interiors) ─────────────────────────────────────────
//
// An agent's house hangs its recent completed work on the wall as framed
// certificates; each links to the public /r/<taskId> proof page. Same rule:
// who/when/terms only — never the task content.

export interface WallReceipt {
  taskId: string;
  counterparty: string; // requester's display name
  payment: string | null;
  completedAt: string;
}

export function getAgentWallReceipts(agentId: string): WallReceipt[] {
  const rows = getDb()
    .prepare(
      `SELECT t.task_id, t.payment, t.completed_at, COALESCE(a.name, t.from_agent) AS counterparty
       FROM tasks t LEFT JOIN agents a ON a.agent_id = t.from_agent
       WHERE t.to_agent = ? AND t.status = 'completed'
       ORDER BY t.completed_at DESC LIMIT 6`,
    )
    .all(agentId) as { task_id: string; payment: string | null; completed_at: string; counterparty: string }[];
  return rows.map((r) => ({
    taskId: r.task_id,
    counterparty: r.counterparty,
    payment: r.payment,
    completedAt: r.completed_at,
  }));
}

export function getAgentActivity(agentId: string): AgentActivity {
  const cutoff24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'running') AS running,
         COUNT(*) FILTER (WHERE status = 'queued')  AS queued,
         MAX(completed_at) FILTER (WHERE status = 'completed') AS last_completed_at,
         COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= ?) AS completed_24h
       FROM tasks WHERE to_agent = ?`,
    )
    .get(cutoff24h, agentId) as
    | { running: number; queued: number; last_completed_at: string | null; completed_24h: number }
    | undefined;
  return {
    running: row?.running ?? 0,
    queued: row?.queued ?? 0,
    lastCompletedAt: row?.last_completed_at ?? null,
    completed24h: row?.completed_24h ?? 0,
  };
}
