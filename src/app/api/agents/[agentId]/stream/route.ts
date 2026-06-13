// Streaming endpoint for an agent — responses arrive as SSE text deltas.
//
// POST /api/agents/:agentId/stream
//
// Body: { task: string, context?: object }
// Payment: same options as /x402 — X-Payment (on-chain) or X-MPP-Channel + Authorization (pre-paid)
//
// SSE event types:
//   data: {"text": "..."} — incremental text from the model
//   data: {"done": true, "taskId": "...", "fullText": "..."} — stream complete
//   data: {"error": "...", "code": "..."} — execution error

import { NextRequest } from "next/server";
import { getAgentById } from "@/lib/agents";
import { createTask, completeTask, failTask, confirmAndStartTask } from "@/lib/tasks";
import { createPayment, parsePriceToSol, refundPayment, releasePayment } from "@/lib/payments";
import { logger } from "@/lib/logger";
import { isValidSolanaAddress } from "@/lib/solana";
import { decodePaymentHeader, buildX402Requirements, encodeRequirements } from "@/lib/x402";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { debitChannel, verifyChannelKey, getChannelById, refundDebitForTask, parseMppUsdcPrice } from "@/lib/mpp";
import { formatContext } from "@/lib/formatContext";
import { getProvider, getAgentSystem } from "@/lib/providers";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";

// 20 stream requests per minute per IP — more resource-intensive than regular tasks
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

type Params = { params: Promise<{ agentId: string }> };

function sseEvent(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function jsonError(
  error: string,
  code: string,
  status: number,
  extra?: Record<string, unknown>,
  headers?: Record<string, string>
) {
  return new Response(
    JSON.stringify({ error, code, ...(extra ?? {}) }),
    { status, headers: { "Content-Type": "application/json", ...(headers ?? {}) } }
  );
}

export function POST(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`stream:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) {
    return jsonError("Agent not found", "NOT_FOUND", 404);
  }

  const body = await req.json().catch(() => null) as {
    task?: string;
    from?: string;
    context?: Record<string, unknown>;
  } | null;
  if (!body || typeof body !== "object") {
    return jsonError("Request body must be valid JSON", "INVALID_JSON", 400);
  }

  if (!body.task?.trim()) {
    return jsonError("task is required", "VALIDATION_ERROR", 400);
  }
  if (body.task.length > 32_000) {
    return jsonError("task must be 32 000 characters or fewer", "VALIDATION_ERROR", 400);
  }
  if (body.context && JSON.stringify(body.context).length > 50_000) {
    return jsonError("context must serialize to 50 KB or fewer", "VALIDATION_ERROR", 400);
  }

  if (agent.endpoint) {
    return jsonError(
      "Streaming is only available for Axon-hosted provider agents. Submit endpoint-backed agent work through async tasks.",
      "CONFLICT",
      409
    );
  }

  // Validate the provider is configured before accepting payment
  let provider: ReturnType<typeof getProvider>;
  try {
    provider = getProvider(agent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Provider unavailable";
    return jsonError(msg, "UPSTREAM_ERROR", 503);
  }

  // ── Payment handling (mirrors x402 route) ──────────────────────────────────
  let fromAddress: string;

  if (agent.price) {
    const mppChannelId = req.headers.get("x-mpp-channel");

    if (mppChannelId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mppChannelId)) {
        return jsonError("x-mpp-channel must be a valid UUID", "VALIDATION_ERROR", 400);
      }
      // MPP path
      const authHeader = req.headers.get("authorization") ?? "";
      const channelKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!channelKey || !verifyChannelKey(mppChannelId, channelKey)) {
        return jsonError("Invalid MPP channel ID or key", "AUTH_REQUIRED", 401);
      }
      const channel = getChannelById(mppChannelId);
      if (!channel || channel.status !== "open") {
        return jsonError("MPP channel is closed or not found", "PAYMENT_REQUIRED", 402);
      }
      const price = parseMppUsdcPrice(agent.price);
      if (!price) {
        return jsonError("Agent price is not in USDC — MPP not supported for this agent", "VALIDATION_ERROR", 400);
      }
      if (channel.balanceUsdc < price.amountUsdc) {
        return jsonError(`Insufficient MPP balance: need ${agent.price}`, "PAYMENT_REQUIRED", 402);
      }
      fromAddress = channel.ownerAddress;
    } else {
      // x402 path
      const rawPayment = req.headers.get("x-payment");
      if (!rawPayment) {
        const requirements = buildX402Requirements({
          resource: `${req.nextUrl.origin}/api/agents/${agentId}/stream`,
          price: agent.price,
          description: `${agent.name} streaming task`,
        });
        if (!requirements) {
          return jsonError("Payment processing unavailable", "PAYMENT_UNAVAILABLE", 503);
        }
        return new Response(
          JSON.stringify({ error: "Payment required", code: "PAYMENT_REQUIRED", requirements }),
          {
            status: 402,
            headers: {
              "Content-Type": "application/json",
              "X-Payment-Required": encodeRequirements(requirements),
              "X-MPP-Accepted": "true",
            },
          }
        );
      }
      const paymentHeader = decodePaymentHeader(rawPayment);
      if (!paymentHeader) {
        return jsonError("X-Payment header is malformed or invalid", "VALIDATION_ERROR", 400);
      }
      fromAddress = paymentHeader.payload.from;
    }
  } else {
    const from = body.from ?? "anonymous";
    if (from !== "anonymous" && !isValidSolanaAddress(from) && !getAgentById(from)) {
      return jsonError("from must be a valid Solana address or agent ID", "VALIDATION_ERROR", 400);
    }
    if (from !== "anonymous") {
      const auth = requireApiKey(req);
      if (!auth.ok) return auth.response;
      if (!canAccessIdentity(auth.user, from)) {
        return jsonError("from must be your wallet address or an agent owned by your wallet", "FORBIDDEN", 403);
      }
    } else {
      // 3 free calls per IP total — window is 1 year so refreshing doesn't reset it
      const freeRl = checkRateLimit(`free-demo:${ip}`, 3, 365 * 24 * 60 * 60 * 1000);
      if (!freeRl.allowed) {
        return jsonError(
          "You've used your 3 free demo calls. Connect your Phantom wallet at axon-agents.com/onboarding to get an API key and continue.",
          "FREE_LIMIT_REACHED",
          429
        );
      }
    }
    fromAddress = from;
  }

  // ── Create task record ──────────────────────────────────────────────────────
  let task = createTask({
    fromAgent: fromAddress,
    toAgent: agentId,
    task: body.task.trim(),
    context: body.context,
    payment: agent.price,
    queueQueuedWebhook: false,
    initialStatus: agent.price ? "payment_pending" : "running",
    startedBy: "stream",
  });

  // ── Process payment (after task creation so we have a taskId) ─────────────
  if (agent.price) {
    const mppChannelId = req.headers.get("x-mpp-channel");
    if (mppChannelId) {
      const price = parseMppUsdcPrice(agent.price);
      if (!price) {
        const { getDb } = await import("@/lib/db");
        getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
        return jsonError("Agent price is not in USDC — MPP not supported for this agent", "VALIDATION_ERROR", 400);
      }
      const debit = debitChannel(mppChannelId, agentId, price, task.taskId);
      if (!debit.success) {
        const { getDb } = await import("@/lib/db");
        getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
        return jsonError(debit.error ?? "MPP debit failed", "PAYMENT_FAILED", 402);
      }
      const startedTask = confirmAndStartTask(task.taskId, "stream");
      if (!startedTask) {
        refundDebitForTask(task.taskId);
        const { getDb } = await import("@/lib/db");
        getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
        return jsonError("Task payment could not be confirmed", "INTERNAL_ERROR", 500);
      }
      task = startedTask;
    } else {
      const rawPayment = req.headers.get("x-payment")!;
      const paymentHeader = decodePaymentHeader(rawPayment)!;
      const amountSol = parsePriceToSol(agent.price);
      if (amountSol !== null) {
        try {
          await createPayment({
            taskId: task.taskId,
            fromAgent: fromAddress,
            toAgent: agentId,
            amountSol,
            paymentSignature: paymentHeader.payload.signature,
            priceString: agent.price,
          });
        } catch (err) {
          const { getDb } = await import("@/lib/db");
          getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
          const msg = err instanceof Error ? err.message : "Payment verification failed";
          const status = /is not set|API_KEY|HELIUS/i.test(msg) ? 503 : 402;
          return jsonError(
            status === 503 ? "Payment processing unavailable" : msg,
            status === 503 ? "PAYMENT_UNAVAILABLE" : "PAYMENT_FAILED",
            status
          );
        }
      }
      const startedTask = confirmAndStartTask(task.taskId, "stream");
      if (!startedTask) {
        refundPayment(task.taskId);
        const { getDb } = await import("@/lib/db");
        getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
        return jsonError("Task payment could not be confirmed", "INTERNAL_ERROR", 500);
      }
      task = startedTask;
    }
  }

  const system = getAgentSystem(agent);
  const message = body.task!.trim() + formatContext(body.context);

  // Closed by the ReadableStream cancel() handler when the client disconnects.
  // This causes the `for await` loop to break on the next iteration, preventing
  // runaway inference that burns API tokens after the connection is gone.
  let cancelled = false;
  const keepalivePing = new TextEncoder().encode(": keepalive\n\n");

  const stream = new ReadableStream({
    async start(controller) {
      const chunks: string[] = [];
      // Send a keepalive comment every 20 s so proxies don't close idle SSE connections
      // before the first token arrives from slow models.
      const pingInterval = setInterval(() => {
        try { controller.enqueue(keepalivePing); } catch { /* controller already closed */ }
      }, 20_000);
      try {
        for await (const text of provider.stream(system, message, 2048)) {
          if (cancelled) break;
          chunks.push(text);
          controller.enqueue(sseEvent({ text }));
        }
        if (!cancelled) {
          const fullText = chunks.join("");
          if (completeTask(task.taskId, fullText)) {
            releasePayment(task.taskId);
          }
          controller.enqueue(sseEvent({ done: true, taskId: task.taskId, fullText }));
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Stream execution failed";
          if (failTask(task.taskId, msg)) {
            const refunded = refundPayment(task.taskId);
            if (task.payment && !refunded) logger.error("payment.refund_failed", "Could not refund payment after stream failure", { taskId: task.taskId });
            refundDebitForTask(task.taskId);
          }
          controller.enqueue(sseEvent({ error: msg, code: "UPSTREAM_ERROR" }));
        }
      } finally {
        clearInterval(pingInterval);
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      // Task was never completed — fail it so DB state is consistent and any
      // escrowed payment is refunded rather than stuck in 'running' forever.
      if (failTask(task.taskId, "Client disconnected")) {
        refundPayment(task.taskId);
        refundDebitForTask(task.taskId);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Task-Id": task.taskId,
      ...rateLimitHeaders(rl, RATE_LIMIT),
    },
  });
  });
}
