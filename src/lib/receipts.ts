import { getDb } from "./db";
import type { Task } from "./tasks";
import type { Payment } from "./payments";
import type { WebhookDelivery } from "./webhooks";
import { recommendPaymentPath, type PaymentPathRecommendation } from "./paymentPath";
import { getOutputCommitment, type OutputCommitment } from "./outputCommitment";
import { verifyTaskSpec, type SpecVerification } from "./specCommitment";
import { getTaskProgress, type TaskProgressEntry } from "./progress";
import { getPaymentNotes, type PaymentNote } from "./paymentNotes";
import { getSplitsForTask, type TaskSplit } from "./escrowSplits";
import { getSlaForTask, type TaskSla } from "./sla";

export interface Receipt {
  taskId: string;
  task: Task | null;
  payment: Payment | null;
  webhookDeliveries: Pick<WebhookDelivery, "deliveryId" | "webhookId" | "eventType" | "status" | "attempts" | "responseStatus" | "lastAttemptAt">[];
  recommendedPath: PaymentPathRecommendation;
  specVerification: SpecVerification | null; // job-spec hash pinned at creation + tamper check
  outputCommitment: OutputCommitment | null;
  progress: TaskProgressEntry[];
  notes: PaymentNote[]; // dispute/refund notes attached to this payment
  splits: TaskSplit[]; // escrow split recipients, if the payment is divided across agents
  sla: TaskSla | null; // service-level agreement and its status, if one was set
}

// The public face of a receipt — the explorer privacy rule applies: WHO
// transacted with WHOM, status, timestamps, the tamper-evidence hashes and the
// settlement. NEVER the task content or output; those stay behind the API key.
export interface PublicReceipt {
  taskId: string;
  fromAgent: string;
  fromName: string | null;
  toAgent: string;
  toName: string | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** The agreed payment terms (e.g. "0.25 USDC") — null for free-route tasks. */
  payment: string | null;
  specHash: string | null;
  outputHash: string | null;
  /** Spec recomputed from the stored fields still matches the pinned hash. */
  specVerified: boolean | null;
  settlement: {
    amount: number;
    currency: string;
    status: string;
    signature: string | null;
    settledAt: string | null;
  } | null;
}

export function getPublicReceipt(taskId: string): PublicReceipt | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT task_id, from_agent, to_agent, status, created_at, started_at, completed_at, spec_hash, output_hash, payment
       FROM tasks WHERE task_id = ?`,
    )
    .get(taskId) as
    | {
        task_id: string;
        from_agent: string;
        to_agent: string;
        status: string;
        created_at: string;
        started_at: string | null;
        completed_at: string | null;
        spec_hash: string | null;
        output_hash: string | null;
        payment: string | null;
      }
    | undefined;
  if (!row) return null;

  const pay = db
    .prepare(
      `SELECT amount_sol, currency, status, signature, settled_at
       FROM transactions WHERE task_id = ? ORDER BY (incoming_signature IS NULL) ASC, created_at ASC LIMIT 1`,
    )
    .get(taskId) as
    | { amount_sol: number; currency: string; status: string; signature: string | null; settled_at: string | null }
    | undefined;

  const names = (id: string): string | null => {
    const a = db.prepare("SELECT name FROM agents WHERE agent_id = ?").get(id) as { name: string } | undefined;
    return a?.name ?? null;
  };

  const spec = verifyTaskSpec(taskId);

  return {
    taskId: row.task_id,
    fromAgent: row.from_agent,
    fromName: names(row.from_agent),
    toAgent: row.to_agent,
    toName: names(row.to_agent),
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    payment: row.payment,
    specHash: row.spec_hash,
    outputHash: row.output_hash,
    specVerified: spec && spec.committed ? spec.matches : null,
    settlement: pay
      ? {
          amount: pay.amount_sol,
          currency: pay.currency,
          status: pay.status,
          signature: pay.signature,
          settledAt: pay.settled_at,
        }
      : null,
  };
}

export function getReceipt(taskId: string): Receipt {
  const db = getDb();

  const taskRow = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
  // A split task has a parent row (full amount + on-chain signature) plus a payout
  // row per recipient. Prefer the parent so the receipt shows the actual payment.
  const paymentRow = db
    .prepare("SELECT * FROM transactions WHERE task_id = ? ORDER BY (incoming_signature IS NULL) ASC, created_at ASC LIMIT 1")
    .get(taskId) as Record<string, unknown> | undefined;

  const deliveryRows = db.prepare(`
    SELECT delivery_id, webhook_id, event_type, status, attempts, response_status, last_attempt_at
    FROM webhook_deliveries
    WHERE json_extract(payload, '$.data.taskId') = ?
    ORDER BY created_at ASC
  `).all(taskId) as {
    delivery_id: string;
    webhook_id: string;
    event_type: string;
    status: string;
    attempts: number;
    response_status: number | null;
    last_attempt_at: string | null;
  }[];

  const task: Task | null = taskRow
    ? {
        taskId: taskRow.task_id as string,
        fromAgent: taskRow.from_agent as string,
        toAgent: taskRow.to_agent as string,
        task: taskRow.task as string,
        context: taskRow.context ? (() => { try { return JSON.parse(taskRow.context as string) as Record<string, unknown>; } catch { return undefined; } })() : undefined,
        payment: taskRow.payment as string ?? undefined,
        status: taskRow.status as Task["status"],
        output: taskRow.output as string ?? undefined,
        error: taskRow.error as string ?? undefined,
        createdAt: taskRow.created_at as string,
        startedAt: taskRow.started_at as string ?? undefined,
        completedAt: taskRow.completed_at as string ?? undefined,
        specHash: taskRow.spec_hash as string ?? undefined,
        outputHash: taskRow.output_hash as string ?? undefined,
        outputCommitment: taskRow.output_commitment as string ?? undefined,
        stuckCount: (taskRow.stuck_count as number) ?? 0,
      }
    : null;

  const payment: Payment | null = paymentRow
    ? {
        txId: paymentRow.tx_id as string,
        taskId: paymentRow.task_id as string ?? undefined,
        fromAgent: paymentRow.from_agent as string,
        toAgent: paymentRow.to_agent as string,
        amountSol: paymentRow.amount_sol as number,
        currency: paymentRow.currency as string,
        status: paymentRow.status as Payment["status"],
        signature: paymentRow.signature as string ?? undefined,
        incomingSignature: paymentRow.incoming_signature as string ?? undefined,
        createdAt: paymentRow.created_at as string,
        settledAt: paymentRow.settled_at as string ?? undefined,
      }
    : null;

  // Determine whether there is an open MPP channel for this task's sender
  let hasOpenMppChannel = false;
  if (task?.fromAgent) {
    const mppRow = db
      .prepare("SELECT 1 FROM mpp_channels WHERE owner_address = ? AND status = 'open' LIMIT 1")
      .get(task.fromAgent);
    hasOpenMppChannel = !!mppRow;
  }

  const recommendedPath = recommendPaymentPath({
    agentPrice: task?.payment,
    hasOpenMppChannel,
  });

  return {
    taskId,
    task,
    payment,
    webhookDeliveries: deliveryRows.map((r) => ({
      deliveryId: r.delivery_id,
      webhookId: r.webhook_id,
      eventType: r.event_type as WebhookDelivery["eventType"],
      status: r.status as WebhookDelivery["status"],
      attempts: r.attempts,
      responseStatus: r.response_status ?? undefined,
      lastAttemptAt: r.last_attempt_at ?? undefined,
    })),
    recommendedPath,
    specVerification: verifyTaskSpec(taskId),
    outputCommitment: getOutputCommitment(taskId),
    progress: getTaskProgress(taskId),
    notes: getPaymentNotes(taskId),
    splits: getSplitsForTask(taskId),
    sla: getSlaForTask(taskId),
  };
}
