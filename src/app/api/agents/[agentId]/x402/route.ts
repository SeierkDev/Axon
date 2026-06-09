// x402 endpoint for an agent.
//
// GET  /api/agents/:agentId/x402  — always returns 402 with payment requirements
// POST /api/agents/:agentId/x402  — submit a task; accepts X-Payment (on-chain) or
//                                   X-MPP-Channel + Authorization: Bearer <key> (pre-paid channel)
//
// This is the x402-standard alternative to the existing two-step flow in POST /api/tasks.
// External clients that speak x402 can discover and pay for agent tasks without knowing
// Axon's internal payment API.

import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { createTask, markTaskPaymentConfirmed } from "@/lib/tasks";
import { createPayment, parsePriceToSol, refundPayment } from "@/lib/payments";
import { isValidSolanaAddress } from "@/lib/solana";
import {
  buildX402Requirements,
  encodeRequirements,
  decodePaymentHeader,
} from "@/lib/x402";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { debitChannel, verifyChannelKey, getChannelById, parseMppUsdcPrice, refundDebitForTask } from "@/lib/mpp";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { logger } from "@/lib/logger";

// 30 paid requests per minute per IP — tighter than the free task endpoint
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

type Params = { params: Promise<{ agentId: string }> };

function resourceUrl(req: NextRequest, agentId: string): string {
  return `${req.nextUrl.origin}/api/agents/${agentId}/x402`;
}

function paymentRequiredResponse(
  req: NextRequest,
  agent: { name: string; price: string },
  agentId: string
) {
  const requirements = buildX402Requirements({
    resource: resourceUrl(req, agentId),
    price: agent.price,
    description: `${agent.name} task execution`,
  });
  if (!requirements) {
    return apiError("PAYMENT_UNAVAILABLE", "Payment processing unavailable", 503);
  }
  return NextResponse.json(
    { error: "Payment required", code: "PAYMENT_REQUIRED", requirements },
    {
      status: 402,
      headers: {
        "X-Payment-Required": encodeRequirements(requirements),
        "X-MPP-Accepted": "true",
      },
    }
  );
}

// GET — returns 402 + X-Payment-Required so clients can discover payment terms
export async function GET(req: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) return apiError("NOT_FOUND", "Agent not found", 404);

  if (!agent.price) {
    return NextResponse.json(
      { message: "This agent is free. Submit tasks via POST /api/tasks." },
      { status: 200 }
    );
  }

  return paymentRequiredResponse(req, { name: agent.name, price: agent.price }, agentId);
}

// POST — submit a task with X-Payment (on-chain) or X-MPP-Channel (pre-paid channel)
export async function POST(req: NextRequest, { params }: Params) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`x402:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) return apiError("NOT_FOUND", "Agent not found", 404);

  const body = await req.json().catch(() => null) as {
    task?: string;
    from?: string;
    context?: Record<string, unknown>;
  } | null;
  if (!body || typeof body !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  if (!body.task?.trim()) {
    return apiError("VALIDATION_ERROR", "task is required", 400);
  }
  if (body.task.length > 32_000) {
    return apiError("VALIDATION_ERROR", "task must be 32 000 characters or fewer", 400);
  }
  if (body.context && JSON.stringify(body.context).length > 50_000) {
    return apiError("VALIDATION_ERROR", "context must serialize to 50 KB or fewer", 400);
  }

  // ── Paid agent ──────────────────────────────────────────────────────────────
  if (agent.price) {
    const mppChannelId = req.headers.get("x-mpp-channel");

    // ── MPP path: pre-paid channel debit ──────────────────────────────────────
    if (mppChannelId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mppChannelId)) {
        return apiError("VALIDATION_ERROR", "x-mpp-channel must be a valid UUID", 400);
      }
      const authHeader = req.headers.get("authorization") ?? "";
      const channelKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

      if (!channelKey) {
        return apiError(
          "AUTH_REQUIRED",
          "Authorization: Bearer <channelKey> is required for MPP payments",
          401
        );
      }

      if (!verifyChannelKey(mppChannelId, channelKey)) {
        return apiError("AUTH_REQUIRED", "Invalid MPP channel ID or key", 401);
      }

      const channel = getChannelById(mppChannelId);
      if (!channel || channel.status !== "open") {
        return apiError("PAYMENT_REQUIRED", "MPP channel is closed or not found", 402);
      }

      const price = parseMppUsdcPrice(agent.price);
      if (!price) {
        return apiError("VALIDATION_ERROR", "Agent price is not in USDC — MPP not supported for this agent", 400);
      }

      let task = createTask({
        fromAgent: channel.ownerAddress,
        toAgent: agentId,
        task: body.task.trim(),
        context: body.context,
        payment: agent.price,
        queueQueuedWebhook: false,
        initialStatus: "payment_pending",
      });

      const debit = debitChannel(mppChannelId, agentId, price, task.taskId);
      if (!debit.success) {
        const { getDb } = await import("@/lib/db");
        getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
        return apiError("PAYMENT_FAILED", debit.error ?? "MPP debit failed", 402);
      }
      const confirmedTask = markTaskPaymentConfirmed(task.taskId);
      if (!confirmedTask) {
        refundDebitForTask(task.taskId);
        const { getDb } = await import("@/lib/db");
        getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
        return apiError("INTERNAL_ERROR", "Task payment could not be confirmed", 500);
      }
      task = confirmedTask;

      return NextResponse.json(task, {
        status: 201,
        headers: {
          "X-Payment-Response": "mpp-accepted",
          "X-MPP-Balance": String(debit.remainingBalance?.toFixed(4) ?? "0"),
          ...rateLimitHeaders(rl, RATE_LIMIT),
        },
      });
    }

    // ── x402 path: on-chain payment ───────────────────────────────────────────
    const rawPayment = req.headers.get("x-payment");

    if (!rawPayment) {
      return paymentRequiredResponse(req, { name: agent.name, price: agent.price }, agentId);
    }

    const paymentHeader = decodePaymentHeader(rawPayment);
    if (!paymentHeader) {
      return apiError("VALIDATION_ERROR", "X-Payment header is malformed or invalid", 400);
    }

    // Use the wallet address from the payment header as the authoritative sender identity.
    // body.from is NOT used for paid tasks — anyone can write anything there, but only the
    // actual signing wallet is verified by the on-chain transaction.
    const fromAgent = paymentHeader.payload.from;

    let task = createTask({
      fromAgent,
      toAgent: agentId,
      task: body.task.trim(),
      context: body.context,
      payment: agent.price,
      queueQueuedWebhook: false,
      initialStatus: "payment_pending",
    });

    const amountSol = parsePriceToSol(agent.price);
    if (amountSol !== null) {
      try {
        await createPayment({
          taskId: task.taskId,
          fromAgent,
          toAgent: agentId,
          amountSol,
          paymentSignature: paymentHeader.payload.signature,
          priceString: agent.price,
        });
      } catch (err) {
        const { getDb } = await import("@/lib/db");
        getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
        const msg = err instanceof Error ? err.message : "Payment verification failed";
        if (/is not set|API_KEY|HELIUS/i.test(msg)) {
          return apiError("PAYMENT_UNAVAILABLE", "Payment processing unavailable", 503);
        }
        return apiError("PAYMENT_FAILED", msg, 402);
      }
    }
    const confirmedTask = markTaskPaymentConfirmed(task.taskId);
    if (!confirmedTask) {
      const refunded = refundPayment(task.taskId);
      if (!refunded) logger.error("payment.refund_failed", "Could not refund payment after confirmation failure", { taskId: task.taskId, agentId });
      const { getDb } = await import("@/lib/db");
      getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
      return apiError("INTERNAL_ERROR", "Task payment could not be confirmed", 500);
    }
    task = confirmedTask;

    return NextResponse.json(task, {
      status: 201,
      headers: { "X-Payment-Response": "accepted", ...rateLimitHeaders(rl, RATE_LIMIT) },
    });
  }

  // ── Free agent ──────────────────────────────────────────────────────────────
  const from = body.from ?? "anonymous";
  if (from !== "anonymous" && !isValidSolanaAddress(from) && !getAgentById(from)) {
    return apiError("VALIDATION_ERROR", "from must be a valid Solana address or agent ID", 400);
  }
  if (from !== "anonymous") {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!canAccessIdentity(auth.user, from)) {
      return apiError(
        "FORBIDDEN",
        "from must be your wallet address or an agent owned by your wallet",
        403
      );
    }
  }

  const task = createTask({
    fromAgent: from,
    toAgent: agentId,
    task: body.task.trim(),
    context: body.context,
  });
  return NextResponse.json(task, { status: 201, headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
