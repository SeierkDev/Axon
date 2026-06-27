import { NextRequest, NextResponse } from "next/server";
import { defineSplits, getSplitsForTask, computeSplitAmounts } from "@/lib/escrowSplits";
import { getTaskById } from "@/lib/tasks";
import { getPaymentByTaskId, parsePriceToSol } from "@/lib/payments";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError, type ApiErrorCode } from "@/lib/apiError";
import { defineSplitsSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const SPLIT_ERROR: Record<"INVALID" | "NOT_FOUND", { code: ApiErrorCode; status: number }> = {
  INVALID: { code: "VALIDATION_ERROR", status: 400 },
  NOT_FOUND: { code: "NOT_FOUND", status: 404 },
};

// The split plus the projected per-recipient amounts (shown once the task has an
// escrowed/settled payment to divide).
function splitsView(taskId: string) {
  const splits = getSplitsForTask(taskId);
  const payment = getPaymentByTaskId(taskId);
  const payouts = payment
    ? computeSplitAmounts(payment.amountSol, splits).map((p) => ({ ...p, currency: payment.currency }))
    : [];
  return { taskId, splits, payouts };
}

// GET /api/tasks/[taskId]/splits — view the split (payer only).
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const task = getTaskById(taskId);
  if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, task.fromAgent)) {
    return apiError("FORBIDDEN", "Only the task's payer can view its split", 403);
  }
  return NextResponse.json(splitsView(taskId));
}

// POST /api/tasks/[taskId]/splits — define the escrow split (payer only).
export async function POST(req: NextRequest, ctx: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, () => handlePost(req, ctx));
}

async function handlePost(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`task-splits:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const task = getTaskById(taskId);
  if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, defineSplitsSchema);
  if (!parsed.ok) return parsed.response;

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, task.fromAgent)) {
    return apiError("FORBIDDEN", "Only the task's payer can set its split", 403);
  }

  // Splits must be set before the escrow settles — once the task is terminal the
  // payment has already been released (or refunded), so a split would be ignored.
  if (task.status === "completed" || task.status === "failed") {
    return apiError("CONFLICT", "Task has already settled — define the split before it completes", 409);
  }

  // Splits divide an escrowed payment — a free task has nothing to distribute.
  if (parsePriceToSol(task.payment) === null) {
    return apiError("VALIDATION_ERROR", "Splits require a paid task — this task has no payment to divide", 400);
  }

  const result = defineSplits(taskId, parsed.data.recipients);
  if (!result.success) {
    const mapped = SPLIT_ERROR[result.code];
    return apiError(mapped.code, result.error, mapped.status);
  }
  return NextResponse.json(splitsView(taskId), { status: 200, headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
