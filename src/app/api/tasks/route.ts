import { NextRequest, NextResponse } from "next/server";
import { createTask, getTaskById, getTaskByIdempotency, markTaskPaymentConfirmed, type Task } from "@/lib/tasks";
import { syncToTurso } from "@/lib/db-turso";
import { getAgentById } from "@/lib/agents";
import { createPayment, getPaymentByIncomingSignature, parsePriceToSol, refundPayment } from "@/lib/payments";
import { isValidSolanaAddress } from "@/lib/solana";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { hashIdempotencyPayload, normalizeIdempotencyKey, validateIdempotencyKey } from "@/lib/idempotency";
import { claimTokenFor } from "@/lib/mcpServer";
import { createTaskSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

// 60 requests per minute per IP
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function taskResponse(
  task: Task,
  status: number,
  replayHeader?: "idempotency" | "payment",
  rlHeaders?: Record<string, string>,
  claimToken?: string,
) {
  // claimToken (anonymous hires only) is the read permission for this task's
  // private output — the browser/MCP caller keeps it to poll the result.
  return NextResponse.json(claimToken ? { ...task, claimToken } : task, {
    status,
    headers: {
      ...(replayHeader === "idempotency" ? { "X-Idempotent-Replay": "true" } : {}),
      ...(replayHeader === "payment" ? { "X-Payment-Replay": "true" } : {}),
      ...(rlHeaders ?? {}),
    },
  });
}

export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`tasks:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const parsed = parseBody(raw, createTaskSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const agent = getAgentById(body.to);
  if (!agent) {
    return apiError("NOT_FOUND", `Agent '${body.to}' not found`, 404);
  }

  // from must be a wallet address, a registered agent ID, or "anonymous" (unauthenticated free tasks)
  if (body.from !== "anonymous" && !isValidSolanaAddress(body.from) && !getAgentById(body.from)) {
    return apiError("VALIDATION_ERROR", "from must be a valid Solana address or agent ID", 400);
  }

  // Auth gates all attributed requests — must run before payment check so probing
  // an agent's price without credentials returns 401, not 402.
  if (body.from !== "anonymous") {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!canAccessIdentity(auth.user, body.from)) {
      return apiError(
        "FORBIDDEN",
        "from must be your wallet address or an agent owned by your wallet",
        403
      );
    }
  } else if (!process.env.VITEST && parsePriceToSol(agent.price) === null) {
    // 3 free calls per IP per agent — 1 year window so refreshing the page doesn't
    // reset it. Gates ONLY the actual free lane: an anonymous request to a PAID
    // agent is authorized by its on-chain payment (verified below), so the demo
    // quota must never block a paying hirer (e.g. MCP clients, which are always
    // anonymous and pay per task).
    const freeRl = checkRateLimit(`free-demo:${ip}:${body.to}`, 3, 365 * 24 * 60 * 60 * 1000);
    if (!freeRl.allowed) {
      return apiError(
        "FREE_LIMIT_REACHED",
        "You've used your 3 free demo calls. Connect your Phantom wallet at axon-agents.com/onboarding to get an API key and continue.",
        429
      );
    }
  }

  const payment = agent.price;
  const amountSol = parsePriceToSol(payment);

  // Paid tasks require a payment signature proving USDC was sent to the receiver wallet
  if (amountSol !== null && !body.paymentSignature) {
    return apiError(
      "PAYMENT_REQUIRED",
      "paymentSignature is required for paid tasks — complete the x402 payment first",
      402
    );
  }

  // payerWallet lets an anonymous hire name the wallet that paid — it's verified
  // on-chain as the transaction's signer, so it must be a real address if given.
  if (body.payerWallet && !isValidSolanaAddress(body.payerWallet)) {
    return apiError("VALIDATION_ERROR", "payerWallet must be a valid Solana address", 400);
  }

  const idempotencyKey = normalizeIdempotencyKey(req.headers.get("Idempotency-Key"));
  const idempotencyScope = idempotencyKey ? `tasks:${body.from}` : undefined;
  const idempotencyHash = idempotencyKey ? hashIdempotencyPayload({
    from: body.from,
    to: body.to,
    task: body.task,
    context: body.context ?? null,
    payment: payment ?? null,
    paymentSignature: body.paymentSignature ?? null,
    signature: body.signature ?? null,
  }) : undefined;

  if (idempotencyKey) {
    const keyError = validateIdempotencyKey(idempotencyKey);
    if (keyError) return apiError("VALIDATION_ERROR", keyError, 400);

    const existing = getTaskByIdempotency(idempotencyScope!, idempotencyKey);
    if (existing) {
      if (existing.hash !== idempotencyHash) {
        return apiError("CONFLICT", "Idempotency-Key was already used for a different task request", 409);
      }
      return taskResponse(existing.task, 200, "idempotency", rateLimitHeaders(rl, RATE_LIMIT));
    }
  }

  if (amountSol !== null && body.paymentSignature) {
    const existingPayment = getPaymentByIncomingSignature(body.paymentSignature);
    if (existingPayment?.taskId) {
      const existingTask = getTaskById(existingPayment.taskId);
      if (
        existingTask &&
        existingPayment.fromAgent === body.from &&
        existingPayment.toAgent === body.to &&
        Math.abs(existingPayment.amountSol - amountSol) < 0.000001
      ) {
        return taskResponse(existingTask, 200, "payment", rateLimitHeaders(rl, RATE_LIMIT));
      }
      return apiError("PAYMENT_FAILED", "Payment signature already used", 402);
    }
  }

  let task: Task;
  try {
    task = createTask({
      fromAgent: body.from,
      toAgent: body.to,
      task: body.task,
      context: body.context,
      payment,
      signature: body.signature,
      queueQueuedWebhook: amountSol === null,
      initialStatus: amountSol !== null ? "payment_pending" : "queued",
      idempotencyScope,
      idempotencyKey: idempotencyKey ?? undefined,
      idempotencyHash,
    });
  } catch (err) {
    if (idempotencyKey) {
      const existing = getTaskByIdempotency(idempotencyScope!, idempotencyKey);
      if (existing) {
        if (existing.hash !== idempotencyHash) {
          return apiError("CONFLICT", "Idempotency-Key was already used for a different task request", 409);
        }
        return taskResponse(existing.task, 200, "idempotency", rateLimitHeaders(rl, RATE_LIMIT));
      }
    }
    throw err;
  }

  if (amountSol !== null && body.paymentSignature) {
    try {
      await createPayment({
        taskId: task.taskId,
        fromAgent: body.from,
        toAgent: body.to,
        amountSol,
        paymentSignature: body.paymentSignature,
        priceString: payment,
        payerWallet: body.payerWallet,
      });
    } catch (err) {
      // Payment failed — roll back the task
      const { getDb } = await import("@/lib/db");
      getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
      void syncToTurso();
      const msg = err instanceof Error ? err.message : "Payment verification failed";
      // Don't expose internal config details (missing env vars, etc.) to callers
      const safeMsg = /is not set|API_KEY|HELIUS/i.test(msg)
        ? "Payment processing unavailable"
        : msg;
      return apiError(
        safeMsg === "Payment processing unavailable" ? "PAYMENT_UNAVAILABLE" : "PAYMENT_FAILED",
        safeMsg,
        safeMsg === "Payment processing unavailable" ? 503 : 402
      );
    }
    const confirmedTask = markTaskPaymentConfirmed(task.taskId);
    if (!confirmedTask) {
      refundPayment(task.taskId);
      const { getDb } = await import("@/lib/db");
      getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
      void syncToTurso();
      return apiError("INTERNAL_ERROR", "Task payment could not be confirmed", 500);
    }
    task = confirmedTask;
  }

  // Anonymous hires (no API key) get a claimToken back — the only way to read
  // the private output — so a browser/MCP caller can poll the result.
  const claimToken = body.from === "anonymous" ? claimTokenFor(task.taskId) : undefined;
  return taskResponse(task, 201, undefined, rateLimitHeaders(rl, RATE_LIMIT), claimToken);
}
