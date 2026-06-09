import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { createWebhook, listWebhooks, getWebhookSecret, WEBHOOK_EVENTS } from "@/lib/webhooks";
import type { WebhookEventType } from "@/lib/webhooks";
import { requireAgentOwner } from "@/lib/apiAuth";
import { validatePublicHttpUrl } from "@/lib/urlSecurity";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";
import { createWebhookSchema, parseBody } from "@/lib/schemas";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

// GET /api/webhooks?agentId=<id> — list webhooks for an agent
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get("agentId");
  if (!agentId) return apiError("VALIDATION_ERROR", "agentId is required", 400);
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  return NextResponse.json({ webhooks: listWebhooks(agentId) });
}

// POST /api/webhooks — register a new webhook
export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const parsed = parseBody(raw, createWebhookSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const auth = requireAgentOwner(req, body.agentId);
  if (!auth.ok) return auth.response;

  // 10 webhook registrations per wallet per minute; 20 per IP as a cross-wallet fallback
  const rl = checkRateLimit(`webhooks-create:${auth.user.walletAddress}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
  const ip = getClientIp(req);
  const ipRl = checkRateLimit(`webhooks-create-ip:${ip}`, 20, 60_000);
  if (!ipRl.allowed) return tooManyRequests(ipRl);

  const urlError = await validatePublicHttpUrl(body.url);
  if (urlError) return apiError("VALIDATION_ERROR", urlError.replace("endpoint", "url"), 400);

  const validEvents = WEBHOOK_EVENTS as readonly string[];
  const events: WebhookEventType[] = body.events
    ? (body.events.filter((e) => validEvents.includes(e)) as WebhookEventType[])
    : [...WEBHOOK_EVENTS];

  if (events.length === 0) {
    return apiError(
      "VALIDATION_ERROR",
      `events must include at least one of: ${WEBHOOK_EVENTS.join(", ")}`,
      400
    );
  }

  const webhook = createWebhook({ agentId: body.agentId, url: body.url, events });
  recordAuditEvent({
    req,
    actor: auth.user,
    action: "webhook.created",
    resourceType: "webhook",
    resourceId: webhook.webhookId,
    ownerAgentId: body.agentId,
    metadata: {
      events,
      status: webhook.status,
    },
  });

  // Return the secret once — it is never shown again
  const secret = getWebhookSecret(webhook.webhookId);
  return NextResponse.json({ webhook, secret }, { status: 201, headers: rateLimitHeaders(rl, 10) });
}
