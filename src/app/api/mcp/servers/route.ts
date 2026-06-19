import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { createMcpServer, listMcpServers, getMcpToolsByServer, syncMcpTools } from "@/lib/mcp";
import { createAgent, agentExists, getAgentById } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { syncToTurso } from "@/lib/db-turso";
import { requireAgentOwner } from "@/lib/apiAuth";
import { validatePublicHttpUrl } from "@/lib/urlSecurity";
import { parsePaymentAmount } from "@/lib/solana";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

// GET /api/mcp/servers — list all servers with their tools
export async function GET() {
  const servers = listMcpServers();
  const result = servers.map((s) => ({
    ...s,
    tools: getMcpToolsByServer(s.serverId),
  }));
  return NextResponse.json({ servers: result });
}

// POST /api/mcp/servers — register a new MCP server
export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    name?: string;
    endpoint?: string;
    description?: string;
    ownerAgentId?: string;
    pricePerCall?: string;
  } | null;
  if (!body || typeof body !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  if (!body.name || !body.endpoint) {
    return apiError("VALIDATION_ERROR", "name and endpoint are required", 400);
  }
  if (!body.ownerAgentId) {
    return apiError("VALIDATION_ERROR", "ownerAgentId is required", 400);
  }
  const auth = requireAgentOwner(req, body.ownerAgentId);
  if (!auth.ok) return auth.response;
  const ownerAgent = getAgentById(body.ownerAgentId);
  if (!ownerAgent) {
    return apiError("VALIDATION_ERROR", "ownerAgentId must be a registered agent ID", 400);
  }

  // 5 MCP server registrations per wallet per minute; 10 per IP as a cross-wallet fallback
  const rl = checkRateLimit(`mcp-servers-create:${auth.user.walletAddress}`, 5, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
  const ip = getClientIp(req);
  const ipRl = checkRateLimit(`mcp-servers-create-ip:${ip}`, 10, 60_000);
  if (!ipRl.allowed) return tooManyRequests(ipRl);

  const endpointError = await validatePublicHttpUrl(body.endpoint);
  if (endpointError) return apiError("VALIDATION_ERROR", endpointError, 400);

  const pricePerCall = body.pricePerCall?.trim() || undefined;
  const parsedPrice = pricePerCall ? parsePaymentAmount(pricePerCall) : null;
  if (pricePerCall && (!parsedPrice || parsedPrice.amount <= 0)) {
    return apiError(
      "VALIDATION_ERROR",
      "pricePerCall must look like '0.10 USDC' or '0.05 SOL'",
      400
    );
  }

  // Create the server record
  const server = createMcpServer({
    name: body.name,
    endpoint: body.endpoint,
    description: body.description,
    ownerAgentId: body.ownerAgentId,
    pricePerCall,
  });

  // Register the MCP server as a discoverable agent so it appears in discovery
  if (!agentExists(server.serverId)) {
    createAgent({
      agentId: server.serverId,
      name: server.name,
      capabilities: ["mcp"],
      publicKey: server.serverId,
      price: server.pricePerCall,
      category: "MCP",
      walletAddress: ownerAgent.walletAddress,
      provider: "anthropic",
      createdAt: server.createdAt,
    });
  }

  // Attempt to sync tools — non-fatal if the server is temporarily unreachable
  let tools: Awaited<ReturnType<typeof getMcpToolsByServer>> = [];
  let syncError: string | undefined;
  try {
    tools = await syncMcpTools(server.serverId);

    // Update the agent's capabilities to the actual tool names so discovery works immediately
    if (tools.length > 0) {
      const caps = tools.map((t) => t.name);
      const db = getDb();
      db.prepare("UPDATE agents SET capabilities = ? WHERE agent_id = ?")
        .run(JSON.stringify(caps), server.serverId);
      db.prepare("DELETE FROM agent_capabilities WHERE agent_id = ?").run(server.serverId);
      const insertCap = db.prepare(
        "INSERT OR IGNORE INTO agent_capabilities (capability, agent_id) VALUES (?, ?)"
      );
      for (const cap of caps) insertCap.run(cap, server.serverId);
      void syncToTurso();
    }
  } catch (err) {
    syncError = err instanceof Error ? err.message : "Tool sync failed";
  }

  recordAuditEvent({
    req,
    actor: auth.user,
    action: "mcp_server.created",
    resourceType: "mcp_server",
    resourceId: server.serverId,
    ownerAgentId: server.ownerAgentId,
    ownerWallet: ownerAgent.walletAddress,
    metadata: {
      priced: Boolean(server.pricePerCall),
      toolCount: tools.length,
      syncSucceeded: !syncError,
    },
  });

  return NextResponse.json({ server, tools, syncError }, { status: 201, headers: rateLimitHeaders(rl, 5) });
}
