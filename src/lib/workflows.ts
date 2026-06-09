import { randomUUID } from "crypto";
import { getDb } from "./db";
import { getAgentById } from "./agents";
import { debitChannel, parseMppUsdcPrice, refundDebitForTask } from "./mpp";
import { createTask, markTaskPaymentConfirmed } from "./tasks";
import { logger } from "./logger";

export type WorkflowStatus = "running" | "completed" | "failed";

export interface WorkflowStep {
  stepIndex: number;
  agentId: string;
  taskId: string;
  status: string;
  input: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Workflow {
  workflowId: string;
  fromAgent: string;
  agents: string[];
  initialTask: string;
  status: WorkflowStatus;
  currentStep: number;
  steps: WorkflowStep[];
  finalOutput?: string;
  createdAt: string;
  completedAt?: string;
}

interface WorkflowRow {
  workflow_id: string;
  from_agent: string;
  agents: string;
  initial_task: string;
  status: WorkflowStatus;
  current_step: number;
  final_output: string | null;
  mpp_channel_id: string | null;
  created_at: string;
  completed_at: string | null;
}

interface StepTaskRow {
  task_id: string;
  to_agent: string;
  step_index: number;
  status: string;
  task: string;
  output: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function rowToWorkflow(row: WorkflowRow, steps: StepTaskRow[]): Workflow {
  return {
    workflowId: row.workflow_id,
    fromAgent: row.from_agent,
    agents: (() => { try { return JSON.parse(row.agents) as string[]; } catch { return []; } })(),
    initialTask: row.initial_task,
    status: row.status,
    currentStep: row.current_step,
    steps: steps.map((s) => ({
      stepIndex: s.step_index,
      agentId: s.to_agent,
      taskId: s.task_id,
      status: s.status,
      input: s.task,
      output: s.output ?? undefined,
      error: s.error ?? undefined,
      startedAt: s.started_at ?? undefined,
      completedAt: s.completed_at ?? undefined,
    })),
    finalOutput: row.final_output ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function getSteps(workflowId: string): StepTaskRow[] {
  return getDb()
    .prepare(
      "SELECT task_id, to_agent, step_index, status, task, output, error, started_at, completed_at FROM tasks WHERE workflow_id = ? ORDER BY step_index ASC"
    )
    .all(workflowId) as StepTaskRow[];
}

export function createWorkflow(opts: {
  fromAgent: string;
  agents: string[];
  task: string;
  mppChannelId?: string;
}): Workflow {
  const db = getDb();
  const workflowId = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO workflows (workflow_id, from_agent, agents, initial_task, status, current_step, mpp_channel_id, created_at)
    VALUES (?, ?, ?, ?, 'running', 0, ?, ?)
  `).run(workflowId, opts.fromAgent, JSON.stringify(opts.agents), opts.task, opts.mppChannelId ?? null, createdAt);

  try {
    // Kick off step 0
    createWorkflowStepTask({
      workflowId,
      fromAgent: opts.fromAgent,
      toAgent: opts.agents[0],
      task: opts.task,
      stepIndex: 0,
      mppChannelId: opts.mppChannelId,
    });
  } catch (err) {
    db.prepare("DELETE FROM workflows WHERE workflow_id=?").run(workflowId);
    throw err;
  }

  return getWorkflow(workflowId)!;
}

function createWorkflowStepTask(opts: {
  workflowId: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  stepIndex: number;
  mppChannelId?: string | null;
}): void {
  const agent = getAgentById(opts.toAgent);
  if (!agent) throw new Error(`Agent '${opts.toAgent}' not found`);

  const paidPrice = agent.price ? parseMppUsdcPrice(agent.price) : null;
  if (agent.price && !paidPrice) {
    throw new Error(`Workflow paid step '${opts.toAgent}' must be priced in USDC for MPP delegation`);
  }

  const task = createTask({
    fromAgent: opts.fromAgent,
    toAgent: opts.toAgent,
    task: opts.task,
    payment: agent.price,
    workflowId: opts.workflowId,
    stepIndex: opts.stepIndex,
    queueQueuedWebhook: !paidPrice,
    initialStatus: paidPrice ? "payment_pending" : "queued",
  });

  if (!paidPrice) return;
  if (!opts.mppChannelId) {
    getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
    throw new Error(`Workflow paid step '${opts.toAgent}' requires an MPP channel`);
  }

  const debit = debitChannel(opts.mppChannelId, opts.toAgent, paidPrice, task.taskId);
  if (!debit.success) {
    getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
    throw new Error(debit.error ?? `MPP debit failed for workflow step '${opts.toAgent}'`);
  }

  const confirmed = markTaskPaymentConfirmed(task.taskId);
  if (!confirmed) {
    refundDebitForTask(task.taskId);
    getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
    throw new Error(`Workflow step '${opts.toAgent}' payment could not be confirmed`);
  }
}

export function getWorkflow(workflowId: string): Workflow | null {
  const row = getDb()
    .prepare("SELECT * FROM workflows WHERE workflow_id = ?")
    .get(workflowId) as WorkflowRow | undefined;
  if (!row) return null;
  return rowToWorkflow(row, getSteps(workflowId));
}

export function getWorkflowsByAgent(agentId: string, limit = 20): Workflow[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT * FROM workflows
       WHERE from_agent = ?
          OR EXISTS (SELECT 1 FROM json_each(agents) WHERE json_each.value = ?)
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(agentId, agentId, limit) as WorkflowRow[];

  return rows.map((r) => rowToWorkflow(r, getSteps(r.workflow_id)));
}

// Called automatically after a workflow step task completes
export function advanceWorkflow(workflowId: string, stepIndex: number, output: string): void {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM workflows WHERE workflow_id = ?")
    .get(workflowId) as WorkflowRow | undefined;
  if (!row) return;

  let agents: string[];
  try { agents = JSON.parse(row.agents) as string[]; } catch (err) {
    logger.error("workflow.agents_parse_failed", "Workflow agents JSON is corrupted — failing workflow", {
      workflowId,
      err,
    });
    failWorkflow(workflowId);
    return;
  }
  const nextStep = stepIndex + 1;

  if (nextStep < agents.length) {
    // Create the next step task — output of this step becomes the input
    try {
      createWorkflowStepTask({
        fromAgent: agents[stepIndex],
        toAgent: agents[nextStep],
        task: output,
        workflowId,
        stepIndex: nextStep,
        mppChannelId: row.mpp_channel_id,
      });
    } catch (err) {
      logger.error("workflow.step_failed", "Workflow step creation failed — failing workflow", {
        workflowId,
        stepIndex: nextStep,
        agentId: agents[nextStep],
        err: err instanceof Error ? err.message : String(err),
      });
      failWorkflow(workflowId);
      return;
    }
    db.prepare("UPDATE workflows SET current_step = ? WHERE workflow_id = ?").run(nextStep, workflowId);
  } else {
    // All steps done — mark workflow completed
    db.prepare(
      "UPDATE workflows SET status='completed', final_output=?, completed_at=? WHERE workflow_id=?"
    ).run(output, new Date().toISOString(), workflowId);
  }
}

export function failWorkflow(workflowId: string): void {
  getDb()
    .prepare("UPDATE workflows SET status='failed', completed_at=? WHERE workflow_id=?")
    .run(new Date().toISOString(), workflowId);
}
