import { NextRequest, NextResponse } from "next/server";
import { getMcpTool, getMcpServer, callMcpTool } from "@/lib/mcp";
import { apiError } from "@/lib/apiError";
import { parsePaymentAmount } from "@/lib/solana";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

type Params = { params: Promise<{ toolId: string }> };

// POST /api/mcp/tools/:toolId/call — synchronous direct tool call
//
// Body: { args: Record<string, unknown>, fromAgent?: string }
//
// Returns the tool result immediately (no task queue). Use the regular
// POST /api/tasks route if you want async/queued execution instead.
export async function POST(req: NextRequest, { params }: Params) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`mcp-tool-call:${ip}`, 20, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const { toolId } = await params;

  const tool = getMcpTool(toolId);
  if (!tool) return apiError("NOT_FOUND", "MCP tool not found", 404);

  const server = getMcpServer(tool.serverId);
  if (!server) return apiError("NOT_FOUND", "MCP server not found", 404);
  if (server.status !== "active") {
    return apiError(
      "UPSTREAM_ERROR",
      `MCP server '${server.name}' is not active (status: ${server.status})`,
      503
    );
  }
  const parsedPrice = parsePaymentAmount(server.pricePerCall);
  if (parsedPrice && parsedPrice.amount > 0) {
    return NextResponse.json(
      {
        error: "Payment required. Submit paid MCP work through /api/tasks or the agent x402 endpoint.",
        code: "PAYMENT_REQUIRED",
        agentId: server.serverId,
        price: server.pricePerCall,
      },
      { status: 402 }
    );
  }

  const body = await req.json().catch(() => null) as { args?: Record<string, unknown> } | null;
  if (!body || typeof body !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const args = body.args ?? {};

  let output: string;
  try {
    output = await callMcpTool(toolId, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Tool call failed";
    return apiError("UPSTREAM_ERROR", msg, 502);
  }

  return NextResponse.json({
    toolId,
    toolName: tool.name,
    serverId: tool.serverId,
    output,
  });
}
