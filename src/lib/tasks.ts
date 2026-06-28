import { randomUUID } from "crypto";
import { getDb } from "./db";
import { queueWebhookEvent } from "./webhooks";
import { recordTaskLatency } from "./metrics";
import { updateAgentReputation } from "./reputation";
import { advanceWorkflow, failWorkflow } from "./workflows";
import { onChildTaskCompleted, onChildTaskFailed } from "./quorum";
import { logger } from "./logger";
import { emitAxonEvent } from "./eventBus";
import { commitOutput } from "./outputCommitment";
import { syncToTurso } from "./db-turso";
import { resolveTraceId, runWithTraceId } from "./tracing";

export type TaskStatus = "payment_pending" | "queued" | "running" | "completed" | "failed";

export interface Task {
  taskId: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  context?: Record<string, unknown>;
  payment?: string;
  status: TaskStatus;
  output?: string;
  error?: string;
  signature?: string;
  workflowId?: string;
  stepIndex?: number;
  quorumId?: string;
  createdAt: string;
  startedAt?: string;
  startedBy?: string;
  completedAt?: string;
  outputHash?: string;
  outputCommitment?: string;
  traceId?: string;
  stuckCount: number;
}

interface TaskRow {
  task_id: string;
  from_agent: string;
  to_agent: string;
  task: string;
  context: string | null;
  payment: string | null;
  status: TaskStatus;
  output: string | null;
  error: string | null;
  signature: string | null;
  idempotency_scope: string | null;
  idempotency_key: string | null;
  idempotency_hash: string | null;
  workflow_id: string | null;
  step_index: number | null;
  quorum_id: string | null;
  created_at: string;
  started_at: string | null;
  started_by: string | null;
  completed_at: string | null;
  output_hash: string | null;
  output_commitment: string | null;
  trace_id: string | null;
  stuck_count: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    taskId: row.task_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    task: row.task,
    context: row.context ? (() => { try { return JSON.parse(row.context) as Record<string, unknown>; } catch { return undefined; } })() : undefined,
    payment: row.payment ?? undefined,
    status: row.status,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    signature: row.signature ?? undefined,
    workflowId: row.workflow_id ?? undefined,
    stepIndex: row.step_index ?? undefined,
    quorumId: row.quorum_id ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    startedBy: row.started_by ?? undefined,
    completedAt: row.completed_at ?? undefined,
    outputHash: row.output_hash ?? undefined,
    outputCommitment: row.output_commitment ?? undefined,
    traceId: row.trace_id ?? undefined,
    stuckCount: row.stuck_count ?? 0,
  };
}

export interface CreateTaskOptions {
  fromAgent: string;
  toAgent: string;
  task: string;
  context?: Record<string, unknown>;
  payment?: string;
  signature?: string;
  idempotencyScope?: string;
  idempotencyKey?: string;
  idempotencyHash?: string;
  workflowId?: string;
  stepIndex?: number;
  quorumId?: string;
  queueQueuedWebhook?: boolean;
  initialStatus?: Extract<TaskStatus, "payment_pending" | "queued" | "running">;
  startedBy?: string;
  traceId?: string;
}

export function queueTaskQueuedWebhook(task: Task): void {
  queueWebhookEvent(task.toAgent, "task.queued", {
    taskId: task.taskId,
    fromAgent: task.fromAgent,
    toAgent: task.toAgent,
    task: task.task,
    payment: task.payment,
    createdAt: task.createdAt,
  });
}

export function createTask(opts: CreateTaskOptions): Task {
  const db = getDb();
  const taskId = randomUUID();
  const createdAt = new Date().toISOString();
  const initialStatus = opts.initialStatus ?? "queued";
  const startedAt = initialStatus === "running" ? createdAt : null;
  const startedBy = initialStatus === "running" ? (opts.startedBy ?? "api") : null;
  const traceId = opts.traceId ?? resolveTraceId();

  db.prepare(`
    INSERT INTO tasks (task_id, from_agent, to_agent, task, context, payment, status, created_at, started_at, started_by, signature, idempotency_scope, idempotency_key, idempotency_hash, workflow_id, step_index, quorum_id, trace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    opts.fromAgent,
    opts.toAgent,
    opts.task,
    opts.context ? JSON.stringify(opts.context) : null,
    opts.payment ?? null,
    initialStatus,
    createdAt,
    startedAt,
    startedBy,
    opts.signature ?? null,
    opts.idempotencyScope ?? null,
    opts.idempotencyKey ?? null,
    opts.idempotencyHash ?? null,
    opts.workflowId ?? null,
    opts.stepIndex ?? null,
    opts.quorumId ?? null,
    traceId,
  );

  const task = getTaskById(taskId)!;
  if (initialStatus === "queued" && opts.queueQueuedWebhook !== false) queueTaskQueuedWebhook(task);
  void syncToTurso(); // covers task INSERT + any webhook_deliveries INSERT above
  logger.info("task.created", "Task created", {
    taskId: task.taskId,
    traceId: task.traceId,
    fromAgent: task.fromAgent,
    toAgent: task.toAgent,
    status: task.status,
    hasPayment: Boolean(task.payment),
    workflowId: task.workflowId,
    stepIndex: task.stepIndex,
  });
  emitAxonEvent({ type: "task.updated", data: { taskId: task.taskId, status: task.status, agentId: task.toAgent, fromAgent: task.fromAgent } });
  return task;
}

export function getTaskById(taskId: string): Task | null {
  const row = getDb()
    .prepare("SELECT * FROM tasks WHERE task_id = ?")
    .get(taskId) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function getTaskByIdempotency(scope: string, key: string): { task: Task; hash: string | null } | null {
  const row = getDb()
    .prepare("SELECT * FROM tasks WHERE idempotency_scope = ? AND idempotency_key = ?")
    .get(scope, key) as TaskRow | undefined;
  return row ? { task: rowToTask(row), hash: row.idempotency_hash } : null;
}

export function startTask(taskId: string, startedBy = "api"): Task | null {
  const db = getDb();
  const now = new Date().toISOString();
  const changes = db
    .prepare("UPDATE tasks SET status='running', started_at=?, started_by=? WHERE task_id=? AND status='queued'")
    .run(now, startedBy, taskId).changes;
  if (changes === 0) return null;
  void syncToTurso();

  const task = getTaskById(taskId)!;
  logger.info("task.started", "Task started", {
    taskId: task.taskId,
    toAgent: task.toAgent,
    startedBy: task.startedBy,
  });
  emitAxonEvent({ type: "task.updated", data: { taskId: task.taskId, status: "running", agentId: task.toAgent, fromAgent: task.fromAgent } });
  return task;
}

export function markTaskPaymentConfirmed(taskId: string): Task | null {
  const changes = getDb()
    .prepare("UPDATE tasks SET status='queued' WHERE task_id=? AND status='payment_pending'")
    .run(taskId).changes;
  if (changes === 0) return null;

  const task = getTaskById(taskId)!;
  // Best-effort notification — a webhook failure must never leave a paid task
  // stuck in payment_pending.
  try {
    queueTaskQueuedWebhook(task);
  } catch (err) {
    logger.error("webhook.queue_failed", "Failed to queue task.queued webhook", {
      err,
      taskId: task.taskId,
      toAgent: task.toAgent,
    });
  }
  void syncToTurso(); // covers task UPDATE + webhook_deliveries INSERT
  logger.info("task.payment_confirmed", "Task payment confirmed", {
    taskId: task.taskId,
    fromAgent: task.fromAgent,
    toAgent: task.toAgent,
    payment: task.payment,
  });
  return task;
}

export function confirmAndStartTask(taskId: string, startedBy = "api"): Task | null {
  const now = new Date().toISOString();
  const changes = getDb()
    .prepare("UPDATE tasks SET status='running', started_at=?, started_by=? WHERE task_id=? AND status='payment_pending'")
    .run(now, startedBy, taskId).changes;
  if (changes === 0) return null;
  void syncToTurso();

  const task = getTaskById(taskId)!;
  logger.info("task.started", "Paid task confirmed and started", {
    taskId: task.taskId,
    toAgent: task.toAgent,
    startedBy: task.startedBy,
    payment: task.payment,
  });
  return task;
}

export function completeTask(taskId: string, output: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  // The status flip and its synchronous DB side-effects (latency, workflow/quorum
  // bookkeeping, reputation, webhook queue) run in ONE transaction, so a crash
  // can't leave a task 'completed' with stale reputation, an un-advanced
  // workflow/quorum, or no webhook queued. Async/network work (commitOutput,
  // Turso sync) and pure events stay outside.
  const task = db.transaction((): Task | null => {
    const changes = db
      .prepare(
        "UPDATE tasks SET status='completed', output=?, completed_at=? WHERE task_id=? AND status='running'"
      )
      .run(output, now, taskId).changes;
    if (changes === 0) return null;

    const t = getTaskById(taskId)!;

    if (t.startedAt && t.completedAt) {
      const latencyMs = new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime();
      recordTaskLatency(t.toAgent, latencyMs, true);
    }
    if (t.workflowId !== undefined && t.stepIndex !== undefined) {
      runWithTraceId(t.traceId ?? t.taskId, () => advanceWorkflow(t.workflowId!, t.stepIndex!, output));
    }
    if (t.quorumId !== undefined) {
      onChildTaskCompleted(t.quorumId);
    }
    updateAgentReputation(t.toAgent);
    return t;
  })();

  if (!task) return null;

  // Webhook delivery is a best-effort notification — a queue failure must not
  // roll back an already-settled task, so it runs outside the transaction.
  try {
    queueWebhookEvent(task.toAgent, "task.completed", {
      taskId: task.taskId,
      fromAgent: task.fromAgent,
      toAgent: task.toAgent,
      task: task.task,
      output: task.output,
      completedAt: task.completedAt,
    });
  } catch (err) {
    logger.error("webhook.queue_failed", "Failed to queue task.completed webhook", {
      err,
      taskId: task.taskId,
      toAgent: task.toAgent,
    });
  }

  logger.info("task.completed", "Task completed", {
    taskId: task.taskId,
    fromAgent: task.fromAgent,
    toAgent: task.toAgent,
    workflowId: task.workflowId,
    stepIndex: task.stepIndex,
  });

  emitAxonEvent({ type: "task.updated", data: { taskId: task.taskId, status: "completed", agentId: task.toAgent, fromAgent: task.fromAgent } });

  // Fire-and-forget — don't block task completion on Solana confirmation
  if (task.output) void commitOutput(taskId, task.output).catch(() => {});

  void syncToTurso();

  return task;
}

export function failTask(taskId: string, error: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  // Same atomicity as completeTask: the status flip and its synchronous DB
  // side-effects commit together or not at all.
  const task = db.transaction((): Task | null => {
    const changes = db
      .prepare(
        "UPDATE tasks SET status='failed', error=?, completed_at=? WHERE task_id=? AND status IN ('queued','running','payment_pending')"
      )
      .run(error, now, taskId).changes;
    if (changes === 0) return null;

    const t = getTaskById(taskId)!;

    if (t.startedAt && t.completedAt) {
      const latencyMs = new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime();
      recordTaskLatency(t.toAgent, latencyMs, false);
    }
    if (t.workflowId !== undefined) {
      failWorkflow(t.workflowId);
    }
    if (t.quorumId !== undefined) {
      onChildTaskFailed(t.quorumId);
    }
    updateAgentReputation(t.toAgent);
    return t;
  })();

  if (!task) return null;

  // Best-effort notification, outside the transaction (see completeTask).
  try {
    queueWebhookEvent(task.toAgent, "task.failed", {
      taskId: task.taskId,
      fromAgent: task.fromAgent,
      toAgent: task.toAgent,
      task: task.task,
      error: task.error,
      completedAt: task.completedAt,
    });
  } catch (err) {
    logger.error("webhook.queue_failed", "Failed to queue task.failed webhook", {
      err,
      taskId: task.taskId,
      toAgent: task.toAgent,
    });
  }

  logger.warn("task.failed", "Task failed", {
    taskId: task.taskId,
    fromAgent: task.fromAgent,
    toAgent: task.toAgent,
    workflowId: task.workflowId,
    stepIndex: task.stepIndex,
    error: task.error,
  });

  emitAxonEvent({ type: "task.updated", data: { taskId: task.taskId, status: "failed", agentId: task.toAgent, fromAgent: task.fromAgent } });

  void syncToTurso();

  return task;
}

export function requeueTask(taskId: string): Task | null {
  const db = getDb();
  const changes = db
    .prepare("UPDATE tasks SET status='queued', error=NULL, started_at=NULL, started_by=NULL, completed_at=NULL, stuck_count=0 WHERE task_id=? AND status='failed'")
    .run(taskId).changes;
  if (changes === 0) return null;
  const task = getTaskById(taskId)!;
  queueTaskQueuedWebhook(task);
  void syncToTurso(); // covers task UPDATE + webhook_deliveries INSERT
  logger.info("task.requeued", "Failed task requeued for retry", { taskId, toAgent: task.toAgent });
  return task;
}

export interface GetTasksOptions {
  agentId: string;
  role?: "sender" | "recipient" | "both";
  status?: TaskStatus;
  limit?: number;
}

export function getTasksByAgent(opts: GetTasksOptions): Task[] {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const role = opts.role ?? "both";

  let whereClause: string;
  let args: unknown[];

  if (role === "sender") {
    whereClause = "from_agent = ?";
    args = [opts.agentId];
  } else if (role === "recipient") {
    whereClause = "to_agent = ?";
    args = [opts.agentId];
  } else {
    // Parentheses are required — AND binds tighter than OR in SQL
    whereClause = "(from_agent = ? OR to_agent = ?)";
    args = [opts.agentId, opts.agentId];
  }

  if (opts.status) {
    whereClause += " AND status = ?";
    args.push(opts.status);
  } else {
    whereClause += " AND status != 'payment_pending'";
  }

  let sql = `SELECT * FROM tasks WHERE ${whereClause}`;

  sql += " ORDER BY created_at DESC LIMIT ?";
  args.push(limit);

  const rows = db.prepare(sql).all(...args) as TaskRow[];
  return rows.map(rowToTask);
}
