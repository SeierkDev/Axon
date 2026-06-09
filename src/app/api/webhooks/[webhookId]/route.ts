import { NextRequest, NextResponse } from "next/server";
import { getWebhookById, deleteWebhook, getDeliveriesByWebhook } from "@/lib/webhooks";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";
import { withRequestContext } from "@/lib/withRequestContext";

type Params = { params: Promise<{ webhookId: string }> };

// GET /api/webhooks/:webhookId — get webhook + recent delivery history
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const { webhookId } = await params;
  const webhook = getWebhookById(webhookId);
  if (!webhook) return apiError("NOT_FOUND", "Webhook not found", 404);
  if (!canAccessIdentity(auth.user, webhook.agentId)) {
    return apiError("FORBIDDEN", "API key does not own this webhook's agent", 403);
  }

  const deliveries = getDeliveriesByWebhook(webhookId, 20);
  return NextResponse.json({ webhook, deliveries });
}

// DELETE /api/webhooks/:webhookId
export async function DELETE(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const { webhookId } = await params;
    const webhook = getWebhookById(webhookId);
    if (!webhook) return apiError("NOT_FOUND", "Webhook not found", 404);
    if (!canAccessIdentity(auth.user, webhook.agentId)) {
      return apiError("FORBIDDEN", "API key does not own this webhook's agent", 403);
    }

    deleteWebhook(webhookId);
    recordAuditEvent({
      req,
      actor: auth.user,
      action: "webhook.deleted",
      resourceType: "webhook",
      resourceId: webhookId,
      ownerAgentId: webhook.agentId,
      metadata: {
        status: webhook.status,
        events: webhook.events,
      },
    });
    return NextResponse.json({ deleted: webhookId });
  });
}
