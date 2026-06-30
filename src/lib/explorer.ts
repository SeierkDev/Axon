// Phase 9: public network explorer.
//
// A block-explorer-style view of the network: recent tasks and settlements
// across all agents, plus headline totals. It exposes metadata only — who
// transacted with whom, status, amount, and time — never task content or
// outputs, which can be private. The point is to make the network's activity
// publicly verifiable, the way a chain explorer makes transactions verifiable.

import { getDb } from "./db";
import { getNetworkStats } from "./analytics";

export interface ExplorerTask {
  taskId: string;
  fromAgent: string;
  toAgent: string;
  status: string;
  createdAt: string;
  completedAt?: string;
}

export interface ExplorerSettlement {
  txId: string;
  taskId?: string;
  fromAgent: string;
  toAgent: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  settledAt?: string;
}

export interface ExplorerTotals {
  agents: number;
  tasksCompleted: number;
  usdcTransacted: number;
  successRate: number;
}

export interface ExplorerFeed {
  totals: ExplorerTotals;
  recentTasks: ExplorerTask[];
  recentSettlements: ExplorerSettlement[];
}

const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  const n = Number.isFinite(limit) ? (limit as number) : 25;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

export function getRecentTasks(limit?: number): ExplorerTask[] {
  const rows = getDb()
    .prepare(
      "SELECT task_id, from_agent, to_agent, status, created_at, completed_at FROM tasks ORDER BY created_at DESC LIMIT ?"
    )
    .all(clampLimit(limit)) as {
    task_id: string;
    from_agent: string;
    to_agent: string;
    status: string;
    created_at: string;
    completed_at: string | null;
  }[];
  return rows.map((r) => ({
    taskId: r.task_id,
    fromAgent: r.from_agent,
    toAgent: r.to_agent,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? undefined,
  }));
}

export function getRecentSettlements(limit?: number): ExplorerSettlement[] {
  const rows = getDb()
    .prepare(
      // Exclude 'split' rows: those are the original escrow kept as a bookkeeping
      // parent after distribution — the actual value movements are the child
      // 'completed'/'refunded' payout rows, so showing the parent too would
      // double up one settlement and scatter it across the time-ordered feed.
      `SELECT tx_id, task_id, from_agent, to_agent, amount_sol, currency, status, created_at, settled_at
         FROM transactions
        WHERE status != 'split'
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .all(clampLimit(limit)) as {
    tx_id: string;
    task_id: string | null;
    from_agent: string;
    to_agent: string;
    amount_sol: number;
    currency: string;
    status: string;
    created_at: string;
    settled_at: string | null;
  }[];
  return rows.map((r) => ({
    txId: r.tx_id,
    taskId: r.task_id ?? undefined,
    fromAgent: r.from_agent,
    toAgent: r.to_agent,
    amount: r.amount_sol,
    currency: r.currency,
    status: r.status,
    createdAt: r.created_at,
    settledAt: r.settled_at ?? undefined,
  }));
}

export function getExplorerFeed(limit?: number): ExplorerFeed {
  let totals: ExplorerTotals = { agents: 0, tasksCompleted: 0, usdcTransacted: 0, successRate: 0 };
  try {
    const stats = getNetworkStats();
    totals = {
      agents: stats.agents.total,
      tasksCompleted: stats.tasks.completed,
      usdcTransacted: stats.payments.totalUsdcTransacted,
      successRate: stats.tasks.successRate,
    };
  } catch {
    // Fall back to zeroed totals so the explorer still renders if stats fail.
  }
  return {
    totals,
    recentTasks: getRecentTasks(limit),
    recentSettlements: getRecentSettlements(limit),
  };
}
