// POST /api/webhooks/deliveries/:deliveryId/retry
// Resets a failed delivery to pending so the worker picks it up on the next cycle.

import { NextRequest, NextResponse } from "next/server";
import { getAgentIdByDeliveryId, getWebhookIdByDeliveryId, retryDelivery } from "@/lib/webhooks";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";

type Params = { params: Promise<{ deliveryId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const { deliveryId } = await params;
  const agentId = getAgentIdByDeliveryId(deliveryId);
  if (!agentId) {
    return apiError("NOT_FOUND", "Delivery not found", 404);
  }
  if (!canAccessIdentity(auth.user, agentId)) {
    return apiError("FORBIDDEN", "API key does not own this delivery's agent", 403);
  }

  const queued = retryDelivery(deliveryId);
  if (!queued) {
    return apiError("NOT_FOUND", "Delivery not found or is not in 'failed' state", 404);
  }
  recordAuditEvent({
    req,
    actor: auth.user,
    action: "webhook.retried",
    resourceType: "webhook_delivery",
    resourceId: deliveryId,
    ownerAgentId: agentId,
    metadata: {
      webhookId: getWebhookIdByDeliveryId(deliveryId),
      webhookReactivated: true,
    },
  });
  return NextResponse.json({ deliveryId, status: "pending", webhookReactivated: true });
}
