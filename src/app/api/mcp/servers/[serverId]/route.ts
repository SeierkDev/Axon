import { NextRequest, NextResponse } from "next/server";
import { getMcpServer, getMcpToolsByServer, deleteMcpServer } from "@/lib/mcp";
import { getDb } from "@/lib/db";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";

type Params = { params: Promise<{ serverId: string }> };

// GET /api/mcp/servers/:serverId
export async function GET(_req: NextRequest, { params }: Params) {
  const { serverId } = await params;
  const server = getMcpServer(serverId);
  if (!server) return apiError("NOT_FOUND", "MCP server not found", 404);
  return NextResponse.json({ server, tools: getMcpToolsByServer(serverId) });
}

// DELETE /api/mcp/servers/:serverId
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const { serverId } = await params;
  const server = getMcpServer(serverId);
  if (!server) return apiError("NOT_FOUND", "MCP server not found", 404);
  if (!server.ownerAgentId) {
    return apiError("FORBIDDEN", "MCP server has no ownerAgentId and cannot be deleted via public API", 403);
  }
  if (!canAccessIdentity(auth.user, server.ownerAgentId)) {
    return apiError("FORBIDDEN", "API key does not own this MCP server", 403);
  }

  deleteMcpServer(serverId);
  // Also remove the auto-created agent entry
  getDb().prepare("DELETE FROM agents WHERE agent_id = ?").run(serverId);
  recordAuditEvent({
    req,
    actor: auth.user,
    action: "mcp_server.deleted",
    resourceType: "mcp_server",
    resourceId: serverId,
    ownerAgentId: server.ownerAgentId,
    metadata: {
      status: server.status,
    },
  });

  return NextResponse.json({ deleted: serverId });
}
