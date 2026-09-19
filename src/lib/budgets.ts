import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { toWei, weiToEth, formatEth } from "./money";

export interface Budget {
  budgetId: string;
  agentId: string;
  name?: string;
  maxPerCallEth?: number;   // max ETH per single payment
  maxPerDayEth?: number;    // max ETH in a rolling calendar day (UTC)
  allowedToAgents?: string[]; // null = any agent allowed
  status: "active" | "paused";
  createdAt: string;
}

export interface BudgetStatus extends Budget {
  spentTodayEth: number;
  remainingTodayEth: number | null;
}

interface BudgetRow {
  budget_id: string;
  agent_id: string;
  name: string | null;
  max_per_call_eth: number | null;
  max_per_day_eth: number | null;
  allowed_to_agents: string | null;
  status: string;
  created_at: string;
}

function rowToBudget(row: BudgetRow): Budget {
  return {
    budgetId: row.budget_id,
    agentId: row.agent_id,
    name: row.name ?? undefined,
    maxPerCallEth: row.max_per_call_eth ?? undefined,
    maxPerDayEth: row.max_per_day_eth ?? undefined,
    allowedToAgents: row.allowed_to_agents
      ? (() => { try { return JSON.parse(row.allowed_to_agents) as string[]; } catch { return undefined; } })()
      : undefined,
    status: row.status as Budget["status"],
    createdAt: row.created_at,
  };
}

export function createBudget(opts: {
  agentId: string;
  name?: string;
  maxPerCallEth?: number;
  maxPerDayEth?: number;
  allowedToAgents?: string[];
}): Budget {
  const db = getDb();
  const budgetId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_budgets (budget_id, agent_id, name, max_per_call_eth, max_per_day_eth, allowed_to_agents, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name              = excluded.name,
      max_per_call_eth = excluded.max_per_call_eth,
      max_per_day_eth  = excluded.max_per_day_eth,
      allowed_to_agents = excluded.allowed_to_agents,
      status            = 'active'
  `).run(
    budgetId,
    opts.agentId,
    opts.name ?? null,
    opts.maxPerCallEth ?? null,
    opts.maxPerDayEth ?? null,
    opts.allowedToAgents ? JSON.stringify(opts.allowedToAgents) : null,
    now,
  );
  void syncToTurso();

  return rowToBudget(
    db.prepare("SELECT * FROM agent_budgets WHERE agent_id = ?").get(opts.agentId) as BudgetRow
  );
}

export function getBudget(agentId: string): BudgetStatus | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM agent_budgets WHERE agent_id = ?")
    .get(agentId) as BudgetRow | undefined;
  if (!row) return null;

  const budget = rowToBudget(row);

  // What this agent has spent today (UTC calendar day) across escrowed and completed transactions
  const today = new Date().toISOString().slice(0, 10);
  const { spent } = db.prepare(`
    SELECT COALESCE(SUM(amount_eth), 0) AS spent
    FROM transactions
    WHERE from_agent = ?
      AND status IN ('escrow', 'completed')
      AND date(created_at) = ?
  `).get(agentId, today) as { spent: number };

  const spentWei = toWei(spent) ?? 0n;
  const capWei = budget.maxPerDayEth != null ? toWei(budget.maxPerDayEth) : null;
  return {
    ...budget,
    spentTodayEth: weiToEth(spentWei),
    remainingTodayEth: capWei != null ? weiToEth(capWei > spentWei ? capWei - spentWei : 0n) : null,
  };
}

// Throws a descriptive error if the payment would violate any budget rule.
// Called inside createPayment() before any DB write — if this throws the
// payment is rejected and no money moves.
/**
 * Refuse a spend that would break a cap.
 *
 * The amount arrives in wei and the caps are compared in wei. A cap is the one number a caller
 * cannot be allowed to creep past, and comparing floats is how you creep past it by a rounding
 * error while every log still says the cap held.
 */
export function checkBudget(
  fromAgent: string,
  toAgent: string,
  amountWei: bigint
): void {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM agent_budgets WHERE agent_id = ? AND status = 'active'")
    .get(fromAgent) as BudgetRow | undefined;

  if (!row) return; // no budget = no restrictions

  // Per-call cap
  const perCallWei = row.max_per_call_eth !== null ? toWei(row.max_per_call_eth) : null;
  if (perCallWei !== null && amountWei > perCallWei) {
    throw new Error(
      `Budget exceeded: this call costs ${formatEth(amountWei)} but the per-call cap is ${formatEth(perCallWei)}`
    );
  }

  // Allowed agents
  if (row.allowed_to_agents !== null) {
    try {
      const allowed = JSON.parse(row.allowed_to_agents) as string[];
      if (!allowed.includes(toAgent)) {
        throw new Error(
          `Budget restriction: agent '${fromAgent}' is not allowed to pay agent '${toAgent}'`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Budget restriction")) throw err;
      // malformed allowed_to_agents JSON — skip restriction check, fall through to daily cap
    }
  }

  // Daily cap — sum today's spend
  if (row.max_per_day_eth !== null) {
    const today = new Date().toISOString().slice(0, 10);
    const { spent } = db.prepare(`
      SELECT COALESCE(SUM(amount_eth), 0) AS spent
      FROM transactions
      WHERE from_agent = ?
        AND status IN ('escrow', 'completed')
        AND date(created_at) = ?
    `).get(fromAgent, today) as { spent: number };

    const spentWei = toWei(spent) ?? 0n;
    const dayCapWei = toWei(row.max_per_day_eth) ?? 0n;
    if (spentWei + amountWei > dayCapWei) {
      throw new Error(
        `Budget exceeded: daily cap is ${formatEth(dayCapWei)}, ` +
        `already spent ${formatEth(spentWei)} today`
      );
    }
  }
}

export function deleteBudget(agentId: string): boolean {
  const deleted = getDb()
    .prepare("DELETE FROM agent_budgets WHERE agent_id = ?")
    .run(agentId).changes > 0;
  if (deleted) void syncToTurso();
  return deleted;
}
