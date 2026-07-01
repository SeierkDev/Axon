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
