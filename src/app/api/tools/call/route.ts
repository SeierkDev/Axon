// Run a tool the model asked for.
//
// A function-calling client gets the schemas from /api/tools, hands them to its model, and the model
// comes back saying "call search_agents with this". This is where that lands. It exists so the
// non-MCP half of the world can reach the marketplace without implementing a protocol or installing
// a package: one POST with a name and some arguments.
//
// The work happens in the MCP server module, reached through the same tools/call message an MCP
// client would send. That is deliberate. If this route called the tools itself there would be two
// implementations, and the first time one gained a guard the other did not, hiring would mean
// different things depending on which door you came through.

import { NextRequest, NextResponse } from "next/server";
import { handleMcpMessage } from "@/lib/mcpServer";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * POST /api/tools/call
 *
 * Takes `{ name, arguments }`, which is how OpenAI and xAI describe a tool call, and also accepts
 * `input` and `args` because half the frameworks in this space pick a different word for the same
 * field and a caller should not have to read source to find out which.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`tools-call:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  let body: { name?: unknown; arguments?: unknown; input?: unknown; args?: unknown } | null;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return apiError("VALIDATION_ERROR", "name is required, e.g. { \"name\": \"search_agents\" }", 400);
  }

  const raw = body?.arguments ?? body?.input ?? body?.args ?? {};
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ip,
  );

  // An unknown tool comes back as a JSON-RPC error rather than a result, and over HTTP that deserves
  // a 400: the caller sent something wrong, and a 200 carrying an error is how a bad tool name goes
  // unnoticed until someone reads the logs.
  if (response && "error" in response && response.error) {
    return apiError("VALIDATION_ERROR", response.error.message, 400);
  }

  const result = (response && "result" in response ? response.result : null) as
    | { content?: { type: string; text: string }[]; isError?: boolean }
    | null;

  // MCP carries results as content blocks because that is what a model reads. A function-calling
  // caller wants the value, so the JSON is parsed back out and the blocks are kept alongside for
  // anyone who would rather hand the model exactly what it expects.
  const text = result?.content?.[0]?.text ?? "";
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a tool that answered in plain prose is returned as it stands */
  }

  return NextResponse.json(
    { name, ok: !result?.isError, result: parsed, content: result?.content ?? [] },
    { headers: CORS },
  );
}
