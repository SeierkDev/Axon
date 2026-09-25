// The same tools, in the shape whatever model you are using expects.
//
// Axon already speaks MCP, which covers Claude, Cursor, Windsurf, Cline and Zed. Everything else in
// the world does function calling instead: OpenAI, Grok, Gemini, every framework built on them. Those
// callers want a list of JSON Schemas to hand their model, and somewhere to POST the call the model
// decided to make. Without that they cannot reach the marketplace at all, which is most of the
// people who could be hiring an agent.
//
// The definitions and the execution come from the MCP server module rather than a copy. The shapes
// differ across vendors only in where the schema sits and what the wrapper is called, so translating
// at the edge keeps one implementation of what the tools actually do. Two copies of five tools drift
// apart within a release, and then the model in Cursor and the model in a Python script disagree
// about what hiring means.

import { NextRequest, NextResponse } from "next/server";
import { MCP_TOOLS } from "@/lib/mcpServer";
import { tooManyRequests } from "@/lib/rateLimit";
import { checkTieredRateLimit } from "@/lib/tieredRateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

// A function-calling client is somebody's script or somebody's assistant, never a page on this
// domain, so the schemas are readable from anywhere.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/**
 * The vendors, and the one thing each of them wants differently.
 *
 * `grok` and `gemini` are deliberately aliases rather than their own branches. xAI's API is
 * OpenAI-compatible and Gemini accepts the same declaration shape, so giving them separate names
 * that produce identical output is honest about what a caller needs to ask for without pretending
 * there is a third format to maintain.
 */
type Format = "openai" | "anthropic" | "grok" | "gemini" | "mcp";

const FORMATS: Format[] = ["openai", "anthropic", "grok", "gemini", "mcp"];

function formatTools(format: Format) {
  switch (format) {
    case "anthropic":
      // Anthropic takes the tool flat, with the schema under input_schema.
      return MCP_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));

    case "mcp":
      // What the MCP endpoint itself advertises, for anyone comparing the two.
      return MCP_TOOLS;

    case "openai":
    case "grok":
    case "gemini":
    default:
      // OpenAI wraps the tool in a type/function envelope. xAI and Gemini accept the same.
      return MCP_TOOLS.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * GET /api/tools?format=openai
 *
 * Hand the result straight to a model. The default is OpenAI's shape because it is the one most
 * callers and frameworks expect, and because an unrecognised format quietly returning something
 * unusable is worse than returning the common case.
 */
export async function GET(req: NextRequest) {
  // Widened by what the caller holds. Anonymous callers — most traffic here — get the
  // same limit they always had.
  const { result: rl } = await checkTieredRateLimit(req, "tools", RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const asked = (req.nextUrl.searchParams.get("format") ?? "openai").toLowerCase();
  const format = (FORMATS as string[]).includes(asked) ? (asked as Format) : "openai";
  const origin = req.nextUrl.origin;

  return NextResponse.json(
    {
      format,
      // Said in the payload, so a caller that typo'd the format sees what it actually got rather
      // than wondering why the shape is wrong.
      requested: asked,
      supported: FORMATS,
      tools: formatTools(format),
      call: {
        url: `${origin}/api/tools/call`,
        method: "POST",
        body: { name: "<tool name>", arguments: {} },
      },
      mcp: {
        url: `${origin}/mcp`,
        note: "Claude, Cursor, Windsurf, Cline and Zed can use this endpoint directly instead.",
      },
      docs: `${origin}/docs/mcp`,
    },
    { headers: { ...CORS, "Cache-Control": "public, max-age=300" } },
  );
}
