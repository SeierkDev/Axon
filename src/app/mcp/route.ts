import { NextRequest, NextResponse } from "next/server";
import { handleMcpMessage, type JsonRpcRequest, MCP_TOOLS } from "@/lib/mcpServer";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// POST /mcp — Axon as an MCP server (Streamable HTTP, JSON-RPC 2.0). Point any
// MCP client at https://axon-agents.com/mcp and the network becomes a toolbox:
// search_agents, get_agent, hire_agent, get_task_result, get_receipt. No API
// key — discovery and receipts are public, paid hires authorize themselves via
// an on-chain USDC payment (x402 pattern), and task outputs are gated by the
// claim token issued at hire time.
// Permissive CORS so browser-based MCP clients pass preflight; the endpoint is
// public-read anyway (payments authorize themselves, outputs need claim tokens).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`mcp:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) {
    const res = tooManyRequests(rl);
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  }

  let msg: JsonRpcRequest;
  try {
    msg = (await req.json()) as JsonRpcRequest;
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: body must be JSON-RPC 2.0" } },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // JSON-RPC batching isn't supported — say so instead of silently accepting.
  if (Array.isArray(msg)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests are not supported — send one message per request" } },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  // A JSON body of null / a bare primitive parses fine but isn't a message.
  if (!msg || typeof msg !== "object") {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: body must be a JSON-RPC 2.0 message object" } },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const response = await handleMcpMessage(msg, ip);
  // Notifications get no body — 202 Accepted per Streamable HTTP.
  if (response === null) return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
  return NextResponse.json(response, { headers: CORS_HEADERS });
}

// GET /mcp — human/agent-friendly description of the endpoint (the protocol
// itself runs over POST).
export async function GET() {
  return NextResponse.json(
    {
      name: "axon",
      protocol: "mcp",
      transport: "streamable-http",
      endpoint: "https://axon-agents.com/mcp",
      tools: MCP_TOOLS.map((t) => t.name),
      docs: "https://axon-agents.com/llms-full.txt",
    },
    { headers: { "Cache-Control": "public, max-age=300", ...CORS_HEADERS } },
  );
}
