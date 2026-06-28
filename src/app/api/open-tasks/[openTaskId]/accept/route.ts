import { NextRequest, NextResponse } from "next/server";
import { acceptBid, revertAccept, getOpenTaskById, getBidById } from "@/lib/bidding";
import {
  createPayment,
  getPaymentByIncomingSignature,
  parsePriceToSol,
  refundPayment,
  isTransientPaymentError,
} from "@/lib/payments";
import { markTaskPaymentConfirmed, getTaskById } from "@/lib/tasks";
import { queueWebhookEvent } from "@/lib/webhooks";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError, type ApiErrorCode } from "@/lib/apiError";
import { acceptBidSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const ACCEPT_ERROR: Record<"NOT_FOUND" | "CLOSED" | "INVALID", { code: ApiErrorCode; status: number }> = {
  NOT_FOUND: { code: "NOT_FOUND", status: 404 },
  CLOSED: { code: "CONFLICT", status: 409 },
  INVALID: { code: "VALIDATION_ERROR", status: 400 },
};

// POST /api/open-tasks/[openTaskId]/accept — accept a bid; converts the open
// task into a regular task assigned to the winning agent at the agreed price.
// Paid bids require a paymentSignature (x402) escrowed before the task runs.
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ openTaskId: string }> }
) {
  return withRequestContext(req, () => handlePost(req, ctx));
}

async function handlePost(
  req: NextRequest,
  { params }: { params: Promise<{ openTaskId: string }> }
) {
  const { openTaskId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`accept-bid:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const openTask = getOpenTaskById(openTaskId);
  if (!openTask) return apiError("NOT_FOUND", `Open task '${openTaskId}' not found`, 404);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, acceptBidSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // Only the poster (owner of the open task's `from`) can accept a bid.
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, openTask.fromAgent)) {
    return apiError("FORBIDDEN", "Only the task poster can accept a bid", 403);
  }

  const bid = getBidById(body.bidId);
  if (!bid || bid.openTaskId !== openTaskId) {
    return apiError("NOT_FOUND", "Bid not found for this task", 404);
  }
  const amountSol = parsePriceToSol(bid.price);

  // Paid bid: a payment signature is required to escrow the agreed amount.
  if (amountSol !== null) {
    if (!body.paymentSignature) {
      return apiError(
        "PAYMENT_REQUIRED",
        `paymentSignature is required to accept this bid — pay ${bid.price} to the agent first`,
        402
      );
    }
    if (getPaymentByIncomingSignature(body.paymentSignature)) {
      return apiError("PAYMENT_FAILED", "Payment signature already used", 402);
    }
  }

  // Create the task + close the open task. Paid bids start payment_pending.
  const result = acceptBid(openTaskId, body.bidId, {
    initialStatus: amountSol !== null ? "payment_pending" : "queued",
  });
  if (!result.success) {
    const mapped = ACCEPT_ERROR[result.code];
    return apiError(mapped.code, result.error, mapped.status);
  }

  // For paid bids, escrow the payment now; roll the accept back if it fails.
  if (amountSol !== null && body.paymentSignature) {
    try {
      await createPayment({
        taskId: result.task.taskId,
        fromAgent: openTask.fromAgent,
        toAgent: bid.agentId,
        amountSol,
        paymentSignature: body.paymentSignature,
        priceString: bid.price,
      });
    } catch (err) {
      revertAccept(openTaskId, result.task.taskId);
      const msg = err instanceof Error ? err.message : "payment verification failed";
      // A transient failure (RPC lag, circuit open, tx not yet indexed) is NOT a
      // payment rejection — the on-chain payment may have landed. Return 503 so
      // the caller retries the SAME signature instead of being told it failed and
      // paying a second time.
      if (isTransientPaymentError(err)) {
        return apiError("PAYMENT_UNAVAILABLE", "Payment is still being confirmed — retry shortly with the same payment; do not pay again", 503);
      }
      return apiError("PAYMENT_FAILED", msg, 402);
    }

    const confirmed = markTaskPaymentConfirmed(result.task.taskId);
    if (!confirmed) {
      refundPayment(result.task.taskId);
      revertAccept(openTaskId, result.task.taskId);
      return apiError("INTERNAL_ERROR", "Task payment could not be confirmed", 500);
    }

    // Payment is escrowed and confirmed — now the accept is final, so notify the
    // winner (acceptBid skips this for paid bids precisely so a failed payment
    // above can't have sent a premature "you won").
    queueWebhookEvent(result.task.toAgent, "bid.accepted", {
      openTaskId,
      bidId: body.bidId,
      taskId: result.task.taskId,
    });
  }

  // Return the open task + the now-confirmed task (status reflects the payment).
  const task = getTaskById(result.task.taskId);
  return NextResponse.json(
    { openTask: getOpenTaskById(openTaskId), task: task ?? result.task },
    { status: 200, headers: rateLimitHeaders(rl, RATE_LIMIT) }
  );
}
