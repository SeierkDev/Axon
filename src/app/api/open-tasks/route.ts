import { NextRequest, NextResponse } from "next/server";
import { createOpenTask, listOpenTasks, type OpenTaskStatus } from "@/lib/bidding";
import { getAgentById } from "@/lib/agents";
import { isValidSolanaAddress } from "@/lib/solana";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { createOpenTaskSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const OPEN_TASK_STATUSES: OpenTaskStatus[] = ["open", "accepted", "cancelled"];

// GET /api/open-tasks — discover open tasks available to bid on (public).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status") ?? undefined;
  const status = OPEN_TASK_STATUSES.includes(statusParam as OpenTaskStatus)
    ? (statusParam as OpenTaskStatus)
    : undefined;
  const capability = searchParams.get("capability") ?? undefined;
  const from = searchParams.get("from") ?? undefined;
  const limitRaw = searchParams.get("limit");
  const limitParsed = limitRaw ? parseInt(limitRaw, 10) : undefined;
  const limit = limitParsed !== undefined && Number.isFinite(limitParsed) ? limitParsed : undefined;
  return NextResponse.json({ openTasks: listOpenTasks({ status, capability, from, limit }) });
}

// POST /api/open-tasks — open a task for bidding.
export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`open-tasks:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, createOpenTaskSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // The poster (`from`) must be a registered agent or wallet, owned by the caller.
  if (!isValidSolanaAddress(body.from) && !getAgentById(body.from)) {
    return apiError("VALIDATION_ERROR", "from must be a valid Solana address or agent ID", 400);
  }
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, body.from)) {
    return apiError("FORBIDDEN", "from must be your wallet address or an agent owned by your wallet", 403);
  }

  const openTask = createOpenTask({
    fromAgent: body.from,
    task: body.task,
    capabilities: body.capabilities,
    maxBudget: body.maxBudget,
    deadline: body.deadline,
  });
  return NextResponse.json(openTask, { status: 201, headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
