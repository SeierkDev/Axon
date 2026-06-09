import { NextRequest, NextResponse } from "next/server";
import { createWorkflow } from "@/lib/workflows";
import { getAgentById } from "@/lib/agents";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { getChannelById, parseMppUsdcPrice, verifyChannelKey } from "@/lib/mpp";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";

export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    from?: string;
    agents?: string[];
    task?: string;
  } | null;
  if (!body || typeof body !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  if (!body.from) {
    return apiError("VALIDATION_ERROR", "from is required", 400);
  }
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, body.from)) {
    return apiError("FORBIDDEN", "from must be your wallet address or an agent owned by your wallet", 403);
  }

  // 10 workflow delegations per wallet per minute; 20 per IP as a cross-wallet fallback
  const rl = checkRateLimit(`delegate:${auth.user.walletAddress}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
  const ip = getClientIp(req);
  const ipRl = checkRateLimit(`delegate-ip:${ip}`, 20, 60_000);
  if (!ipRl.allowed) return tooManyRequests(ipRl);

  if (!body.agents?.length || body.agents.length < 2) {
    return apiError("VALIDATION_ERROR", "agents must be an array of at least 2 agent IDs", 400);
  }
  if (body.agents.length > 20) {
    return apiError("VALIDATION_ERROR", "agents must contain 20 or fewer agent IDs", 400);
  }
  if (!body.task) {
    return apiError("VALIDATION_ERROR", "task is required", 400);
  }
  if (body.task.length > 32_000) {
    return apiError("VALIDATION_ERROR", "task must be 32 000 characters or fewer", 400);
  }

  let totalPaidUsdc = 0;

  // Verify all agents in the chain exist and paid steps are MPP-compatible.
  for (const agentId of body.agents) {
    const agent = getAgentById(agentId);
    if (!agent) {
      return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
    }
    if (agent.price) {
      const price = parseMppUsdcPrice(agent.price);
      if (!price) {
        return apiError(
          "VALIDATION_ERROR",
          `Paid delegation only supports USDC-priced agents. '${agentId}' is priced at ${agent.price}.`,
          400
        );
      }
      totalPaidUsdc += price.amountUsdc;
    }
  }

  let mppChannelId: string | undefined;
  if (totalPaidUsdc > 0) {
    mppChannelId = req.headers.get("x-mpp-channel") ?? undefined;
    const authHeader = req.headers.get("authorization") ?? "";
    const channelKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (!mppChannelId || !channelKey) {
      return apiError(
        "PAYMENT_REQUIRED",
        "Paid delegation requires X-MPP-Channel and Authorization: Bearer <channelKey>",
        402
      );
    }
    if (!verifyChannelKey(mppChannelId, channelKey)) {
      return apiError("AUTH_REQUIRED", "Invalid MPP channel ID or key", 401);
    }

    const channel = getChannelById(mppChannelId);
    if (!channel || channel.status !== "open") {
      return apiError("PAYMENT_REQUIRED", "MPP channel is closed or not found", 402);
    }
    if (channel.ownerAddress !== auth.user.walletAddress) {
      return apiError("FORBIDDEN", "MPP channel owner must match the authenticated API key owner", 403);
    }
    if (channel.balanceUsdc < totalPaidUsdc) {
      return apiError(
        "PAYMENT_REQUIRED",
        `Insufficient MPP balance for paid delegation: need ${totalPaidUsdc.toFixed(6)} USDC`,
        402
      );
    }
  }

  let workflow: ReturnType<typeof createWorkflow>;
  try {
    workflow = createWorkflow({
      fromAgent: body.from,
      agents: body.agents,
      task: body.task,
      mppChannelId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Workflow could not be created";
    const status = /balance|debit|channel|payment/i.test(msg) ? 402 : 500;
    return apiError(status === 402 ? "PAYMENT_FAILED" : "INTERNAL_ERROR", msg, status);
  }

  return NextResponse.json(workflow, { status: 201, headers: rateLimitHeaders(rl, 10) });
}
