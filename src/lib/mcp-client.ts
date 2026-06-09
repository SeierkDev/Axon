// MCP Streamable HTTP client (protocol version 2025-03-26).
// Handles both plain JSON and SSE responses from MCP servers.

import { publicHttpFetch } from "./urlSecurity";

const TIMEOUT_MS = 30_000;

// Module-level counter so IDs are globally unique across all McpHttpClient instances.
// Each instance is created fresh per call, so an instance-level counter always resets to 1.
let globalSeq = 1;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string } };

export interface McpCallResult {
  content: McpContentBlock[];
  isError: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpHttpClient {
  constructor(private readonly endpoint: string) {}

  async listTools(): Promise<McpTool[]> {
    const result = await this.rpc("tools/list", {}) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.rpc("tools/call", { name, arguments: args }) as Partial<McpCallResult>;
    return {
      content: result.content ?? [],
      isError: result.isError ?? false,
    };
  }

  // Converts McpCallResult content blocks to a plain string for storage
  static resultToText(result: McpCallResult): string {
    if (result.content.length === 0) return "(no output)";
    return result.content
      .map((c) => {
        if (c.type === "text") return c.text;
        if (c.type === "image") return `[Image: ${c.mimeType}]`;
        return `[Resource: ${c.resource.uri}]`;
      })
      .join("\n")
      .trim();
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = globalSeq++;
    const reqBody: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    // Single AbortController covers BOTH the fetch connection AND the body read
    // (Response.text() / Response.json() / readSse() all respect the same signal).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await publicHttpFetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
        maxResponseBytes: 2_000_000,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`MCP server returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
      }

      const ct = res.headers.get("content-type") ?? "";
      // Both branches use the same abort-controlled signal via the Response object
      const rpc = ct.includes("text/event-stream")
        ? await this.readSse(res, id)
        : (await res.json()) as JsonRpcResponse;

      if (rpc.error) {
        throw new Error(`MCP error ${rpc.error.code}: ${rpc.error.message}`);
      }
      if (rpc.result === undefined) {
        throw new Error(`MCP server returned no result for method '${method}'`);
      }
      return rpc.result;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`MCP request to ${this.endpoint} timed out after ${TIMEOUT_MS / 1000}s`);
      }
      // Re-wrap TypeError (network failures) with context; re-throw everything else as-is
      if (err instanceof TypeError) {
        throw new Error(`MCP connection to ${this.endpoint} failed: ${err.message}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSse(res: Response, expectedId: number): Promise<JsonRpcResponse> {
    // res.text() is covered by the abort signal from the outer rpc() AbortController
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(line.slice(6)) as JsonRpcResponse;
        if (parsed.id === expectedId) return parsed;
      } catch {
        // skip malformed lines
      }
    }
    throw new Error(`MCP SSE response contained no data event matching id ${expectedId}`);
  }
}
