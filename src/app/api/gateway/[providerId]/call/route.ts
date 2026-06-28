// Gateway call endpoint — verifies payment then proxies the request upstream.
//
// Payment options (checked in order):
//   1. X-Payment header (x402 protocol)
//   2. paymentSignature in body (existing Axon flow)
//   3. No payment required (free provider)
//
// Returns the upstream response verbatim, plus Axon metering headers.

import { NextRequest, NextResponse } from "next/server";
import { getGatewayProvider, proxyToProvider } from "@/lib/gateway";
import { createTask, startTask, completeTask, failTask, markTaskPaymentConfirmed } from "@/lib/tasks";
import { syncToTurso } from "@/lib/db-turso";
import { createPayment, parsePriceToSol, refundPayment, releasePayment, isTransientPaymentError } from "@/lib/payments";
import { isValidSolanaAddress } from "@/lib/solana";
import { agentExists } from "@/lib/agents";
import {
  buildX402Requirements,
  encodeRequirements,
  decodePaymentHeader,
} from "@/lib/x402";
import { apiError } from "@/lib/apiError";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

type Params = { params: Promise<{ providerId: string }> };

function requiresPayment(
  req: NextRequest,
  provider: { name: string; pricePerCall: string },
  providerId: string
) {
  const requirements = buildX402Requirements({
    resource: `${req.nextUrl.origin}/api/gateway/${providerId}/call`,
    price: provider.pricePerCall,
    description: `${provider.name} API call`,
  });
  if (!requirements) {
    return apiError("PAYMENT_UNAVAILABLE", "Payment processing unavailable", 503);
  }
  return NextResponse.json(
    { error: "Payment required", code: "PAYMENT_REQUIRED", requirements },
    { status: 402, headers: { "X-Payment-Required": encodeRequirements(requirements) } }
  );
}

export async function POST(req: NextRequest, { params }: Params) {
  const { providerId } = await params;

  const ip = getClientIp(req);
  const rl = checkRateLimit(`gateway-call:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const provider = getGatewayProvider(providerId);
  if (!provider) return apiError("NOT_FOUND", "Provider not found", 404);
  if (provider.status !== "active") {
    return apiError("UPSTREAM_ERROR", `Provider '${provider.name}' is not active`, 503);
  }

  // Read body once — needed for both payment extraction and proxying
  const rawBody = await req.text().catch(() => "");
  let parsedBody: Record<string, unknown> = {};
  let isJsonBody = false;
  try {
    if (rawBody) {
      parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
      isJsonBody = true;
    }
  } catch {
    // non-JSON body — forwarded as-is
  }

  let from = (typeof parsedBody.from === "string" ? parsedBody.from : null) ?? "anonymous";
  // Validate from — must be a wallet address, registered agent, or "anonymous"
  if (from !== "anonymous" && !isValidSolanaAddress(from) && !agentExists(from)) {
    return apiError("VALIDATION_ERROR", "from must be a valid Solana address or agent ID", 400);
  }

  // Strip Axon-specific fields before forwarding.
  // For JSON bodies, ALWAYS use the stripped payload (even if it becomes {}).
  // For non-JSON bodies, forward the raw bytes unchanged.
  const upstreamPayload = { ...parsedBody };
  delete upstreamPayload.from;
  delete upstreamPayload.paymentSignature;
  const upstreamBody = isJsonBody ? JSON.stringify(upstreamPayload) : rawBody;

  const isPaid = !!provider.pricePerCall;

  // ── Payment challenge extraction ────────────────────────────────────────────
  // We only create a task once the caller has provided payment proof or the
  // provider is free. Paid tasks stay hidden as payment_pending until verified.
  let paymentSignature: string | undefined;
  let fromX402 = false;

  if (isPaid) {
    const rawX402 = req.headers.get("x-payment");
    const bodySignature = typeof parsedBody.paymentSignature === "string"
      ? parsedBody.paymentSignature
      : null;

    if (!rawX402 && !bodySignature) {
      return requiresPayment(req, { name: provider.name, pricePerCall: provider.pricePerCall }, providerId);
    }

    if (rawX402) {
      const paymentHeader = decodePaymentHeader(rawX402);
      if (!paymentHeader) {
        return apiError("VALIDATION_ERROR", "X-Payment header is malformed or invalid", 400);
      }
      from = paymentHeader.payload.from;
      paymentSignature = paymentHeader.payload.signature;
      fromX402 = true; // identity derived from a verified payment, not the body
    } else {
      paymentSignature = bodySignature!;
    }
  }

  // Authenticate the claimed identity for body-supplied `from` (mirrors
  // /api/tasks). The x402 path above derives `from` from a verified payment, so
  // that path doesn't need an API key; everything else must prove ownership of
  // the identity it bills the task to.
  if (from !== "anonymous" && !fromX402) {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!canAccessIdentity(auth.user, from)) {
      return apiError("FORBIDDEN", "from must be your wallet address or an agent you own", 403);
    }
  }

  // ── Create task + verify payment ────────────────────────────────────────────
  const task = createTask({
    fromAgent: from,
    toAgent: providerId,
    task: upstreamBody.slice(0, 500),
    payment: isPaid ? provider.pricePerCall : undefined,
    queueQueuedWebhook: !isPaid,
    initialStatus: isPaid ? "payment_pending" : "queued",
  });

  if (isPaid && paymentSignature) {
    const amountSol = parsePriceToSol(provider.pricePerCall);
    if (amountSol !== null) {
      try {
        await createPayment({
          taskId: task.taskId,
          fromAgent: from,
          toAgent: providerId,
          amountSol,
          paymentSignature,
          priceString: provider.pricePerCall,
        });
      } catch (err) {
        const { getDb } = await import("@/lib/db");
        getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
        void syncToTurso();
        const msg = err instanceof Error ? err.message : "Payment verification failed";
        if (isTransientPaymentError(err)) {
          return apiError("PAYMENT_UNAVAILABLE", "Payment is still being confirmed — retry shortly with the same payment", 503);
        }
        return apiError("PAYMENT_FAILED", msg, 402);
      }
    }
    if (!markTaskPaymentConfirmed(task.taskId)) {
      refundPayment(task.taskId);
      const { getDb } = await import("@/lib/db");
      getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
      void syncToTurso();
      return apiError("INTERNAL_ERROR", "Task payment could not be confirmed", 500);
    }
  }

  // startTask transitions queued→running so completeTask/failTask can find it.
  // Paid tasks only become queued after payment confirmation, so this must happen
  // after markTaskPaymentConfirmed().
  if (!startTask(task.taskId, "gateway")) {
    if (isPaid) refundPayment(task.taskId);
    failTask(task.taskId, "Task could not be started");
    return apiError("INTERNAL_ERROR", "Task could not be started", 500);
  }

  // ── Proxy to upstream ───────────────────────────────────────────────────────
  const incomingHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => { incomingHeaders[key] = value; });

  let result: Awaited<ReturnType<typeof proxyToProvider>>;
  try {
    result = await proxyToProvider(provider, incomingHeaders, upstreamBody || undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upstream error";
    if (failTask(task.taskId, msg)) {
      refundPayment(task.taskId);
    }
    return apiError("UPSTREAM_ERROR", msg, 502);
  }

  if (completeTask(task.taskId, result.body.slice(0, 1000))) {
    releasePayment(task.taskId);
  }

  return new NextResponse(result.body, {
    status: result.status,
    headers: {
      ...result.headers,
      "X-Axon-Task-Id": task.taskId,
      "X-Axon-Duration-Ms": String(result.durationMs),
      "X-Axon-Provider": providerId,
    },
  });
}
