// Phase 8: bidding and quotes before task acceptance.
//
// A poster opens a task (without a fixed agent); agents submit bids (price,
// optional ETA, pitch); the poster accepts one bid, which converts the open
// task into a regular task assigned to the winning agent at the agreed price.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { createTask, type Task } from "./tasks";
import { getAgentById } from "./agents";
import { parsePaymentAmount } from "./solana";
import { queueWebhookEvent } from "./webhooks";
import { logger } from "./logger";

export type OpenTaskStatus = "open" | "accepted" | "cancelled";
export type BidStatus = "pending" | "accepted" | "rejected";

export interface OpenTask {
  openTaskId: string;
  fromAgent: string;
  task: string;
  capabilities: string[];
  maxBudget?: string;
  status: OpenTaskStatus;
  acceptedBidId?: string;
  acceptedTaskId?: string;
  deadline?: string;
  createdAt: string;
}

export interface Bid {
  bidId: string;
  openTaskId: string;
  agentId: string;
  price: string;
  etaSeconds?: number;
  message?: string;
  status: BidStatus;
  createdAt: string;
}

interface OpenTaskRow {
  open_task_id: string;
  from_agent: string;
  task: string;
  capabilities: string;
  max_budget: string | null;
  status: string;
  accepted_bid_id: string | null;
  accepted_task_id: string | null;
  deadline: string | null;
  created_at: string;
}

interface BidRow {
  bid_id: string;
  open_task_id: string;
  agent_id: string;
  price: string;
  eta_seconds: number | null;
  message: string | null;
  status: string;
  created_at: string;
}

function rowToOpenTask(row: OpenTaskRow): OpenTask {
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities);
    if (Array.isArray(parsed)) capabilities = parsed.filter((c): c is string => typeof c === "string");
  } catch {
    /* malformed — treat as none */
  }
  return {
    openTaskId: row.open_task_id,
    fromAgent: row.from_agent,
    task: row.task,
    capabilities,
    maxBudget: row.max_budget ?? undefined,
    status: row.status as OpenTaskStatus,
    acceptedBidId: row.accepted_bid_id ?? undefined,
    acceptedTaskId: row.accepted_task_id ?? undefined,
    deadline: row.deadline ?? undefined,
    createdAt: row.created_at,
  };
}

function rowToBid(row: BidRow): Bid {
  return {
    bidId: row.bid_id,
    openTaskId: row.open_task_id,
    agentId: row.agent_id,
    price: row.price,
    etaSeconds: row.eta_seconds ?? undefined,
    message: row.message ?? undefined,
    status: row.status as BidStatus,
    createdAt: row.created_at,
  };
}

// ── Open tasks ──────────────────────────────────────────────────────────────

export interface CreateOpenTaskInput {
  fromAgent: string;
  task: string;
  capabilities: string[];
  maxBudget?: string;
  deadline?: string;
}

export function createOpenTask(input: CreateOpenTaskInput): OpenTask {
  const db = getDb();
  const openTaskId = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO open_tasks (open_task_id, from_agent, task, capabilities, max_budget, status, deadline, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(
    openTaskId,
    input.fromAgent,
    input.task,
    JSON.stringify(input.capabilities),
    input.maxBudget ?? null,
    input.deadline ?? null,
    createdAt
  );
  void syncToTurso();
  const created = getOpenTaskById(openTaskId)!;
  logger.info("open_task.created", "Open task created", { openTaskId, fromAgent: input.fromAgent });
  return created;
}

export function getOpenTaskById(openTaskId: string): OpenTask | null {
  const row = getDb()
    .prepare("SELECT * FROM open_tasks WHERE open_task_id = ?")
    .get(openTaskId) as OpenTaskRow | undefined;
  return row ? rowToOpenTask(row) : null;
}

export interface ListOpenTasksOptions {
  status?: OpenTaskStatus;
  capability?: string;
  from?: string;
  limit?: number;
}

export function listOpenTasks(opts: ListOpenTasksOptions = {}): OpenTask[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Filter capability in SQL (case-insensitive LIKE on the quoted token) so the
  // LIMIT applies to matching rows — an in-memory filter after LIMIT would let
  // non-matching tasks fill the window and silently drop matching ones.
  const capPattern = opts.capability ? `%"${opts.capability}"%` : null;
  const rows = getDb()
    .prepare(
      `SELECT * FROM open_tasks
       WHERE (? IS NULL OR status = ?)
         AND (? IS NULL OR from_agent = ?)
         AND (? IS NULL OR capabilities LIKE ?)
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(opts.status ?? null, opts.status ?? null, opts.from ?? null, opts.from ?? null, capPattern, capPattern, limit) as OpenTaskRow[];
  return rows.map(rowToOpenTask);
}

export function cancelOpenTask(openTaskId: string): OpenTask | null {
  const db = getDb();
  const changes = db
    .prepare("UPDATE open_tasks SET status='cancelled' WHERE open_task_id=? AND status='open'")
    .run(openTaskId).changes;
  void syncToTurso();
  return changes > 0 ? getOpenTaskById(openTaskId) : null;
}

// ── Bids ────────────────────────────────────────────────────────────────────

export interface SubmitBidInput {
  openTaskId: string;
  agentId: string;
  price: string;
  etaSeconds?: number;
  message?: string;
}

export type BidErrorCode = "NOT_FOUND" | "CLOSED" | "INVALID" | "DUPLICATE" | "FORBIDDEN";
export type BidResult =
  | { success: true; bid: Bid }
  | { success: false; error: string; code: BidErrorCode };

export function submitBid(input: SubmitBidInput): BidResult {
  const db = getDb();
  const openTask = getOpenTaskById(input.openTaskId);
  if (!openTask) return { success: false, error: "Open task not found", code: "NOT_FOUND" };
  if (openTask.status !== "open") {
    return { success: false, error: "Open task is no longer accepting bids", code: "CLOSED" };
  }
  // The bidding window closes at the deadline (NaN guards a malformed value).
  if (openTask.deadline && Date.parse(openTask.deadline) < Date.now()) {
    return { success: false, error: "The bidding deadline has passed", code: "CLOSED" };
  }
  if (!getAgentById(input.agentId)) {
    return { success: false, error: `Agent '${input.agentId}' not found`, code: "NOT_FOUND" };
  }
  if (input.agentId === openTask.fromAgent) {
    return { success: false, error: "You cannot bid on your own task", code: "FORBIDDEN" };
  }

  const parsedPrice = parsePaymentAmount(input.price);
  if (!parsedPrice) {
    return { success: false, error: 'price must be a valid amount, e.g. "0.05 USDC"', code: "INVALID" };
  }
  if (openTask.maxBudget) {
    const budget = parsePaymentAmount(openTask.maxBudget);
    if (budget) {
      // Enforce the ceiling in the budget's own currency. A mismatched currency
      // (e.g. a SOL bid against a USDC budget) can't be compared, so reject it
      // rather than silently letting it bypass the budget entirely.
      if (parsedPrice.currency !== budget.currency) {
        return { success: false, error: `Bid must be priced in ${budget.currency} to match the task's budget`, code: "INVALID" };
      }
      if (parsedPrice.amount > budget.amount) {
        return { success: false, error: `Bid exceeds the max budget of ${openTask.maxBudget}`, code: "INVALID" };
      }
    }
  }

  const bidId = randomUUID();
  const createdAt = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO bids (bid_id, open_task_id, agent_id, price, eta_seconds, message, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(bidId, input.openTaskId, input.agentId, input.price, input.etaSeconds ?? null, input.message ?? null, createdAt);
  } catch (err) {
    // UNIQUE (open_task_id, agent_id) — one bid per agent per open task.
    if (String(err).includes("UNIQUE")) {
      return { success: false, error: "You have already bid on this task", code: "DUPLICATE" };
    }
    throw err;
  }
  // Notify the poster a bid came in (so they don't have to poll).
  queueWebhookEvent(openTask.fromAgent, "bid.received", {
    openTaskId: input.openTaskId,
    bidId,
    agentId: input.agentId,
    price: input.price,
  });
  void syncToTurso();
  return { success: true, bid: getBidById(bidId)! };
}

export function getBidById(bidId: string): Bid | null {
  const row = getDb().prepare("SELECT * FROM bids WHERE bid_id = ?").get(bidId) as BidRow | undefined;
  return row ? rowToBid(row) : null;
}

export function getBidsForOpenTask(openTaskId: string): Bid[] {
  const rows = getDb()
    .prepare("SELECT * FROM bids WHERE open_task_id = ? ORDER BY created_at ASC")
    .all(openTaskId) as BidRow[];
  return rows.map(rowToBid);
}

// ── Accept ──────────────────────────────────────────────────────────────────

export type AcceptResult =
  | { success: true; openTask: OpenTask; task: Task }
  | { success: false; error: string; code: "NOT_FOUND" | "CLOSED" | "INVALID" };

export function acceptBid(
  openTaskId: string,
  bidId: string,
  opts: { initialStatus?: "queued" | "payment_pending" } = {}
): AcceptResult {
  const db = getDb();
  const initialStatus = opts.initialStatus ?? "queued";
  const result = db.transaction((): AcceptResult => {
    const openTask = getOpenTaskById(openTaskId);
    if (!openTask) return { success: false, error: "Open task not found", code: "NOT_FOUND" };
    if (openTask.status !== "open") {
      return { success: false, error: "Open task is no longer open", code: "CLOSED" };
    }
    const bid = getBidById(bidId);
    if (!bid || bid.openTaskId !== openTaskId) {
      return { success: false, error: "Bid not found for this task", code: "NOT_FOUND" };
    }
    if (bid.status !== "pending") {
      return { success: false, error: "Bid is no longer pending", code: "INVALID" };
    }

    // Convert the winning bid into a regular task at the agreed price. Paid bids
    // start in payment_pending until the route confirms the escrow.
    const task = createTask({
      fromAgent: openTask.fromAgent,
      toAgent: bid.agentId,
      task: openTask.task,
      payment: bid.price,
      initialStatus,
      queueQueuedWebhook: initialStatus === "queued",
    });

    db.prepare(
      "UPDATE open_tasks SET status='accepted', accepted_bid_id=?, accepted_task_id=? WHERE open_task_id=?"
    ).run(bid.bidId, task.taskId, openTaskId);
    db.prepare("UPDATE bids SET status='accepted' WHERE bid_id=?").run(bid.bidId);
    db.prepare("UPDATE bids SET status='rejected' WHERE open_task_id=? AND bid_id != ?").run(openTaskId, bid.bidId);

    logger.info("open_task.accepted", "Bid accepted", { openTaskId, bidId, taskId: task.taskId });
    return { success: true, openTask: getOpenTaskById(openTaskId)!, task };
  })();
  // Notify the winning agent — but only for the final accept. A paid accept
  // starts payment_pending; the route emits this AFTER the escrow is confirmed,
  // so a payment that fails (and reverts) never sends a false "you won".
  if (result.success && initialStatus === "queued") {
    queueWebhookEvent(result.task.toAgent, "bid.accepted", {
      openTaskId,
      bidId,
      taskId: result.task.taskId,
    });
  }
  void syncToTurso();
  return result;
}

// Undo an accept when the escrow payment fails — deletes the created task,
// reopens the task, and returns every bid to pending so it can be re-accepted.
export function revertAccept(openTaskId: string, taskId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
    db.prepare(
      "UPDATE open_tasks SET status='open', accepted_bid_id=NULL, accepted_task_id=NULL WHERE open_task_id=?"
    ).run(openTaskId);
    db.prepare("UPDATE bids SET status='pending' WHERE open_task_id=?").run(openTaskId);
  })();
  void syncToTurso();
}
