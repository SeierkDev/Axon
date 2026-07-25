// Phase 11 — the self-assembling planner. Give it a goal and a budget and it
// decomposes the goal into steps, routes each step to the best worker (via the
// Phase 11 router), and projects the cost. "You approve a budget, not a plan."
//
// Decomposition is an injected `think` (the caller's own model), so this is
// testable with a fake and spends nothing on its own. Routing and costing are
// pure functions over the marketplace. Execution creates the routed tasks,
// funded from the paying agent's balance and bounded by its on-chain budget.

import { selectAgent } from "./routing";
import { parsePaymentAmount } from "./solana";
import { getAgentById } from "./agents";
import { createTask, markTaskPaymentConfirmed } from "./tasks";
import { createBalancePayment, refundPayment, parsePriceToSol } from "./payments";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";

export type ThinkFn = (prompt: string, opts?: { maxTokens?: number }) => Promise<string>;

export interface PlanStep {
  capability: string;
  task: string;
}

export interface PlannedStep extends PlanStep {
  /** The worker the router assigned, or null if nothing matched. */
  agentId: string | null;
  agentName?: string;
  price: string | null;
  /** Projected USDC cost for this step (0 for free-lane or non-USDC). */
  costUsdc: number;
  /** Why this worker — the router's reason string. */
  reason: string | null;
}

export interface PlanResult {
  goal: string;
  budgetUsdc: number;
  steps: PlannedStep[];
  estCostUsdc: number;
  withinBudget: boolean;
  /** How many steps got a worker (some may be unroutable). */
  routedCount: number;
}

const planPrompt = (goal: string, maxSteps: number) =>
  `You are an autonomous agent with a real budget, hiring specialist AI agents on a marketplace to accomplish a goal. Break the goal into at most ${maxSteps} concrete sub-tasks, each handled by one specialist.

Goal: ${goal}

Return ONLY a JSON array, no prose, each item: {"capability": "<one lowercase keyword for the kind of specialist, e.g. research, writing, analysis, summarization, fact-checking>", "task": "<a self-contained instruction for that specialist>"}. Order them so earlier results feed later ones.`;

/** Pull the first JSON array out of a model response (tolerates fences / prose). */
export function parsePlan(text: string): PlanStep[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as unknown[];
    return arr
      .filter((x): x is PlanStep =>
        !!x && typeof (x as PlanStep).capability === "string" && typeof (x as PlanStep).task === "string")
      .map((x) => ({ capability: x.capability.trim().toLowerCase(), task: x.task.trim() }));
  } catch {
    return [];
  }
}

function costUsdcOf(price: string | null | undefined): number {
  if (!price) return 0;
  const p = parsePaymentAmount(price);
  return p && p.currency === "USDC" ? p.amount : 0;
}

/** Decompose a goal into ordered specialist steps using the caller's model. */
export async function decomposeGoal(goal: string, maxSteps: number, think: ThinkFn): Promise<PlanStep[]> {
  const raw = await think(planPrompt(goal, maxSteps), { maxTokens: 1200 });
  return parsePlan(raw).slice(0, maxSteps);
}

/** Route each step to its best worker and project the cost — creates nothing. */
export function assignTeam(
  from: string,
  goal: string,
  steps: PlanStep[],
  opts: { budgetUsdc: number; perStepCapUsdc?: number },
): PlanResult {
  const maxPrice = opts.perStepCapUsdc ? `${opts.perStepCapUsdc} USDC` : undefined;
  let est = 0;
  const planned: PlannedStep[] = steps.map((step) => {
    const r = selectAgent({ capability: step.capability, fromAgent: from, maxPrice });
    const c = r ? costUsdcOf(r.agent.price) : 0;
    est += c;
    return {
      ...step,
      agentId: r?.agent.agentId ?? null,
      agentName: r?.agent.name,
      price: r?.agent.price ?? null,
      costUsdc: c,
      reason: r?.reason ?? null,
    };
  });
  return {
    goal,
    budgetUsdc: opts.budgetUsdc,
    steps: planned,
    estCostUsdc: Math.round(est * 1e6) / 1e6,
    withinBudget: est <= opts.budgetUsdc,
    routedCount: planned.filter((p) => p.agentId).length,
  };
}

/** Decompose + assemble the team in one call. */
export async function planTeam(
  cfg: { from: string; goal: string; budgetUsdc: number; maxSteps?: number; perStepCapUsdc?: number },
  think: ThinkFn,
): Promise<PlanResult> {
  const steps = await decomposeGoal(cfg.goal, cfg.maxSteps ?? 5, think);
  return assignTeam(cfg.from, cfg.goal, steps, { budgetUsdc: cfg.budgetUsdc, perStepCapUsdc: cfg.perStepCapUsdc });
}

/**
 * Create one hire, funded from the paying agent's balance if the worker is priced
 * (bounded by its on-chain budget via checkBudget), or free-lane otherwise.
 * Shared by the planner and by subcontracting. Throws if the worker doesn't exist
 * or a budget rule rejects the spend.
 */
export function createHiredTask(
  from: string,
  to: string,
  task: string,
  context?: Record<string, unknown>,
): { taskId: string; price: string | null; costUsdc: number } {
  const worker = getAgentById(to);
  if (!worker) throw new Error(`agent '${to}' not found`);
  const payment = worker.price ?? undefined;
  const amountSol = parsePriceToSol(payment);
  const priced = amountSol !== null && amountSol > 0;
  const t = createTask({
    fromAgent: from,
    toAgent: to,
    task,
    context,
    payment: priced ? payment : undefined,
    initialStatus: priced ? "payment_pending" : "queued",
    queueQueuedWebhook: !priced,
  });
  if (priced) {
    // Mirror the hardened balance path in POST /api/tasks: if the payment or the
    // confirm fails (insufficient balance, a budget cap, an allow-list rejection),
    // roll the task back so it never lingers in payment_pending — a stuck row
    // would inflate the worker's load and skew future routing.
    try {
      createBalancePayment({ taskId: t.taskId, fromAgent: from, toAgent: to, amountSol: amountSol!, priceString: payment });
      const confirmed = markTaskPaymentConfirmed(t.taskId);
      if (!confirmed) throw new Error("payment could not be confirmed");
    } catch (e) {
      // Refund any escrow that was created before deleting the task — otherwise the
      // payer's available balance stays reduced against a task that will never run.
      // refundPayment is a no-op when no escrow row exists (createBalancePayment threw).
      refundPayment(t.taskId);
      getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(t.taskId);
      void syncToTurso();
      throw e;
    }
  }
  return { taskId: t.taskId, price: worker.price ?? null, costUsdc: priced ? costUsdcOf(payment) : 0 };
}

export interface ExecutedStep {
  capability: string;
  agentId: string;
  taskId: string;
  costUsdc: number;
}

/**
 * Create the routed tasks. Priced steps are funded from the paying agent's
 * balance (and bounded by its on-chain budget — createBalancePayment enforces
 * checkBudget). Unroutable steps and steps that would breach the running budget
 * are skipped, not thrown. Returns the created tasks.
 *
 * v1 scope: steps are created independently (no output of one step is threaded
 * into the next), so this fits parallel/independent sub-tasks best; sequential
 * pipelines that feed results forward are a follow-up. The endpoint is not
 * idempotent yet either — a client that retries execute:true can create a second
 * set of hires, so callers should treat a timeout as "unknown" and reconcile.
 */
export function executePlan(from: string, plan: PlanResult): { created: ExecutedStep[]; skipped: number } {
  const created: ExecutedStep[] = [];
  let skipped = 0;
  let spent = 0;
  for (const step of plan.steps) {
    if (!step.agentId) { skipped++; continue; }
    if (spent + step.costUsdc > plan.budgetUsdc + 1e-9) { skipped++; continue; }
    try {
      // createHiredTask funds from balance within budget AND rolls the task back
      // if the payment fails — a failed step skips, never leaks a payment_pending row.
      // No provenance is injected into the worker's prompt (the step task is
      // self-contained); the plan link lives in the response, not the model input.
      const hire = createHiredTask(from, step.agentId, step.task);
      spent += hire.costUsdc;
      created.push({ capability: step.capability, agentId: step.agentId, taskId: hire.taskId, costUsdc: hire.costUsdc });
    } catch {
      // A budget breach or payment failure on one step skips it, not the whole plan.
      skipped++;
    }
  }
  return { created, skipped };
}
