import { NextRequest, NextResponse } from "next/server";
import { getGatewayProvider, deleteGatewayProvider } from "@/lib/gateway";
import { getEndpointUptime } from "@/lib/endpointUptime";
import { getDb } from "@/lib/db";
import { syncToTurso } from "@/lib/db-turso";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";
import type { GatewayProvider } from "@/sdk/types";

type Params = { params: Promise<{ providerId: string }> };

function withoutInjectedHeaders(provider: GatewayProvider): Omit<GatewayProvider, "injectHeaders"> {
  const safeProvider = { ...provider };
  delete safeProvider.injectHeaders;
  return safeProvider;
}

// GET /api/gateway/:providerId — returns provider without injectHeaders (may contain API keys)
export async function GET(_req: NextRequest, { params }: Params) {
  const { providerId } = await params;
  const provider = getGatewayProvider(providerId);
  if (!provider) return apiError("NOT_FOUND", "Provider not found", 404);
  // Surface the endpoint's recorded reliability so callers can judge it before paying.
  // Embedded in the provider (matching the list response) so SDK getters return it.
  return NextResponse.json({
    provider: { ...withoutInjectedHeaders(provider), uptime: getEndpointUptime(providerId) },
  });
}

// DELETE /api/gateway/:providerId
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const { providerId } = await params;
  const provider = getGatewayProvider(providerId);
  if (!provider) return apiError("NOT_FOUND", "Provider not found", 404);

  if (!provider.ownerAgentId) {
    return apiError("FORBIDDEN", "Provider has no ownerAgentId and cannot be deleted via public API", 403);
  }
  if (!canAccessIdentity(auth.user, provider.ownerAgentId)) {
    return apiError("FORBIDDEN", "API key does not own this gateway provider", 403);
  }

  deleteGatewayProvider(providerId);
  getDb().prepare("DELETE FROM agents WHERE agent_id = ?").run(providerId);
  void syncToTurso();
  recordAuditEvent({
    req,
    actor: auth.user,
    action: "gateway.deleted",
    resourceType: "gateway_provider",
    resourceId: providerId,
    ownerAgentId: provider.ownerAgentId,
    metadata: {
      method: provider.method,
      status: provider.status,
    },
  });

  return NextResponse.json({ deleted: providerId });
}
