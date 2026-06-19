import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";

export interface Budget {
  budgetId: string;
  agentId: string;
  name?: string;
  maxPerCallUsdc?: number;   // max USDC per single payment
  maxPerDayUsdc?: number;    // max USDC in a rolling calendar day (UTC)
  allowedToAgents?: string[]; // null = any agent allowed
  status: "active" | "paused";
  createdAt: string;
}

export interface BudgetStatus extends Budget {
  spentTodayUsdc: number;
  remainingTodayUsdc: number | null;
}

interface BudgetRow {
  budget_id: string;
  agent_id: string;
  name: string | null;
  max_per_call_usdc: number | null;
  max_per_day_usdc: number | null;
  allowed_to_agents: string | null;
  status: string;
  created_at: string;
}

function rowToBudget(row: BudgetRow): Budget {
  return {
    budgetId: row.budget_id,
    agentId: row.agent_id,
    name: row.name ?? undefined,
    maxPerCallUsdc: row.max_per_call_usdc ?? undefined,
    maxPerDayUsdc: row.max_per_day_usdc ?? undefined,
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
  maxPerCallUsdc?: number;
  maxPerDayUsdc?: number;
  allowedToAgents?: string[];
}): Budget {
  const db = getDb();
  const budgetId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_budgets (budget_id, agent_id, name, max_per_call_usdc, max_per_day_usdc, allowed_to_agents, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name              = excluded.name,
      max_per_call_usdc = excluded.max_per_call_usdc,
      max_per_day_usdc  = excluded.max_per_day_usdc,
      allowed_to_agents = excluded.allowed_to_agents,
      status            = 'active'
  `).run(
    budgetId,
    opts.agentId,
    opts.name ?? null,
    opts.maxPerCallUsdc ?? null,
    opts.maxPerDayUsdc ?? null,
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

  // Sum USDC spent today (UTC calendar day) across completed transactions
  const today = new Date().toISOString().slice(0, 10);
  const { spent } = db.prepare(`
    SELECT COALESCE(SUM(amount_sol), 0) AS spent
    FROM transactions
    WHERE from_agent = ? AND currency = 'USDC'
      AND status IN ('escrow', 'completed')
      AND date(created_at) = ?
  `).get(agentId, today) as { spent: number };

  return {
    ...budget,
    spentTodayUsdc: Math.round(spent * 10000) / 10000,
    remainingTodayUsdc: budget.maxPerDayUsdc != null
      ? Math.max(0, Math.round((budget.maxPerDayUsdc - spent) * 10000) / 10000)
      : null,
  };
}

// Throws a descriptive error if the payment would violate any budget rule.
// Called inside createPayment() before any DB write — if this throws the
// payment is rejected and no money moves.
export function checkBudget(
  fromAgent: string,
  toAgent: string,
  amountUsdc: number
): void {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM agent_budgets WHERE agent_id = ? AND status = 'active'")
    .get(fromAgent) as BudgetRow | undefined;

  if (!row) return; // no budget = no restrictions

  // Per-call cap
  if (row.max_per_call_usdc !== null && amountUsdc > row.max_per_call_usdc) {
    throw new Error(
      `Budget exceeded: this call costs ${amountUsdc.toFixed(4)} USDC but the per-call cap is ${row.max_per_call_usdc.toFixed(4)} USDC`
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
  if (row.max_per_day_usdc !== null) {
    const today = new Date().toISOString().slice(0, 10);
    const { spent } = db.prepare(`
      SELECT COALESCE(SUM(amount_sol), 0) AS spent
      FROM transactions
      WHERE from_agent = ? AND currency = 'USDC'
        AND status IN ('escrow', 'completed')
        AND date(created_at) = ?
    `).get(fromAgent, today) as { spent: number };

    if (spent + amountUsdc > row.max_per_day_usdc) {
      throw new Error(
        `Budget exceeded: daily cap is ${row.max_per_day_usdc.toFixed(4)} USDC, ` +
        `already spent ${spent.toFixed(4)} USDC today`
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
