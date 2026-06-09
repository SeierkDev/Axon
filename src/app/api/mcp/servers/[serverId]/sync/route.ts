import { NextRequest, NextResponse } from "next/server";
import { getMcpServer, syncMcpTools } from "@/lib/mcp";
import { getDb } from "@/lib/db";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";

type Params = { params: Promise<{ serverId: string }> };

// POST /api/mcp/servers/:serverId/sync — re-fetch tools from the MCP server
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const { serverId } = await params;
  const server = getMcpServer(serverId);
  if (!server) return apiError("NOT_FOUND", "MCP server not found", 404);
  if (!server.ownerAgentId) {
    return apiError("FORBIDDEN", "MCP server has no ownerAgentId and cannot be synced via public API", 403);
  }
  if (!canAccessIdentity(auth.user, server.ownerAgentId)) {
    return apiError("FORBIDDEN", "API key does not own this MCP server", 403);
  }

  let tools: Awaited<ReturnType<typeof syncMcpTools>>;
  try {
    tools = await syncMcpTools(serverId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sync failed";
    return apiError("UPSTREAM_ERROR", msg, 502);
  }

  // Update the agent's capabilities to reflect current tool names
  const caps = tools.map((t) => t.name);
  const db = getDb();
  db.prepare("UPDATE agents SET capabilities = ? WHERE agent_id = ?")
    .run(JSON.stringify(caps.length > 0 ? caps : ["mcp"]), serverId);

  // Rebuild capability index for this agent
  db.prepare("DELETE FROM agent_capabilities WHERE agent_id = ?").run(serverId);
  const insertCap = db.prepare(
    "INSERT OR IGNORE INTO agent_capabilities (capability, agent_id) VALUES (?, ?)"
  );
  for (const cap of caps.length > 0 ? caps : ["mcp"]) {
    insertCap.run(cap, serverId);
  }

  recordAuditEvent({
    req,
    actor: auth.user,
    action: "mcp_server.synced",
    resourceType: "mcp_server",
    resourceId: serverId,
    ownerAgentId: server.ownerAgentId,
    metadata: {
      toolCount: tools.length,
    },
  });

  return NextResponse.json({ synced: tools.length, tools });
}
