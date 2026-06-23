import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import {
  createGatewayProvider,
  listGatewayProviders,
  deleteGatewayProvider,
} from "@/lib/gateway";
import { createAgent, agentExists, getAgentById } from "@/lib/agents";
import { requireAgentOwner } from "@/lib/apiAuth";
import { validatePublicHttpUrl } from "@/lib/urlSecurity";
import { parsePaymentAmount } from "@/lib/solana";
import { getEndpointUptimeMap } from "@/lib/endpointUptime";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";
import type { GatewayProvider } from "@/sdk/types";
import { createGatewaySchema, parseBody } from "@/lib/schemas";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

function withoutInjectedHeaders(provider: GatewayProvider): Omit<GatewayProvider, "injectHeaders"> {
  const safeProvider = { ...provider };
  delete safeProvider.injectHeaders;
  return safeProvider;
}

// GET /api/gateway — list all active providers (injectHeaders omitted — may contain API keys)
export async function GET() {
  const providers = listGatewayProviders("active").map(withoutInjectedHeaders);
  // Attach recorded uptime so callers can compare endpoint reliability (one batched query).
  const uptimes = getEndpointUptimeMap(providers.map((p) => p.providerId));
  const withUptime = providers.map((p) => ({
    ...p,
    uptime: uptimes.get(p.providerId) ?? { checks: 0, up: 0, uptime: 0 },
  }));
  return NextResponse.json({ providers: withUptime });
}

// POST /api/gateway — register a new provider
export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const parsed = parseBody(raw, createGatewaySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const auth = requireAgentOwner(req, body.ownerAgentId);
  if (!auth.ok) return auth.response;
  const ownerAgent = getAgentById(body.ownerAgentId);
  if (!ownerAgent) {
    return apiError("VALIDATION_ERROR", "ownerAgentId must be a registered agent ID", 400);
  }

  // 5 gateway providers per wallet per minute; 10 per IP as a cross-wallet fallback
  const rl = checkRateLimit(`gateway-create:${auth.user.walletAddress}`, 5, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
  const ip = getClientIp(req);
  const ipRl = checkRateLimit(`gateway-create-ip:${ip}`, 10, 60_000);
  if (!ipRl.allowed) return tooManyRequests(ipRl);

  const endpointError = await validatePublicHttpUrl(body.endpoint);
  if (endpointError) return apiError("VALIDATION_ERROR", endpointError, 400);

  const method = body.method ?? "POST";
  const forwardHeaders = body.forwardHeaders ?? [];
  const injectHeaders = body.injectHeaders ?? {};
  const timeoutMs = body.timeoutMs ?? 30_000;

  const pricePerCall = body.pricePerCall?.trim() || undefined;
  const parsedPrice = pricePerCall ? parsePaymentAmount(pricePerCall) : null;
  if (pricePerCall && (!parsedPrice || parsedPrice.amount <= 0)) {
    return apiError(
      "VALIDATION_ERROR",
      "pricePerCall must look like '0.10 USDC' or '0.05 SOL'",
      400
    );
  }

  const provider = createGatewayProvider({
    name: body.name,
    endpoint: body.endpoint,
    method,
    forwardHeaders,
    injectHeaders,
    pricePerCall,
    description: body.description,
    ownerAgentId: body.ownerAgentId,
    timeoutMs,
  });

  // Auto-register as a discoverable agent — roll back the provider if this fails
  if (!agentExists(provider.providerId)) {
    try {
      createAgent({
        agentId: provider.providerId,
        name: provider.name,
        capabilities: ["gateway", "proxy"],
        publicKey: provider.providerId,
        price: provider.pricePerCall,
        category: "Gateway",
        walletAddress: ownerAgent.walletAddress,
        provider: "anthropic",
        createdAt: provider.createdAt,
      });
    } catch (err) {
      deleteGatewayProvider(provider.providerId);
      const msg = err instanceof Error ? err.message : "Failed to register provider as agent";
      return apiError("INTERNAL_ERROR", msg, 500);
    }
  }

  recordAuditEvent({
    req,
    actor: auth.user,
    action: "gateway.created",
    resourceType: "gateway_provider",
    resourceId: provider.providerId,
    ownerAgentId: provider.ownerAgentId,
    ownerWallet: ownerAgent.walletAddress,
    metadata: {
      method: provider.method,
      priced: Boolean(provider.pricePerCall),
      timeoutMs: provider.timeoutMs,
      forwardHeadersCount: provider.forwardHeaders.length,
    },
  });

  // Return provider without injectHeaders — may contain API keys
  return NextResponse.json({ provider: withoutInjectedHeaders(provider) }, { status: 201, headers: rateLimitHeaders(rl, 5) });
}
