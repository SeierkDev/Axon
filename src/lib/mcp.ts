import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { McpHttpClient } from "./mcp-client";
import type { McpTool } from "./mcp-client";

const DEFAULT_PRICE_PER_CALL = "0.10 USDC";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpServer {
  serverId: string;
  name: string;
  endpoint: string;
  description?: string;
  ownerAgentId?: string;
  pricePerCall: string;
  status: "active" | "inactive" | "error";
  createdAt: string;
}

export interface McpToolRecord {
  toolId: string;
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  lastSynced: string;
}

interface McpServerRow {
  server_id: string;
  name: string;
  endpoint: string;
  description: string | null;
  owner_agent_id: string | null;
  price_per_call: string;
  status: string;
  created_at: string;
}

interface McpToolRow {
  tool_id: string;
  server_id: string;
  name: string;
  description: string | null;
  input_schema: string;
  last_synced: string;
}

function rowToServer(row: McpServerRow): McpServer {
  return {
    serverId: row.server_id,
    name: row.name,
    endpoint: row.endpoint,
    description: row.description ?? undefined,
    ownerAgentId: row.owner_agent_id ?? undefined,
    pricePerCall: row.price_per_call,
    status: row.status as McpServer["status"],
    createdAt: row.created_at,
  };
}

function rowToTool(row: McpToolRow): McpToolRecord {
  return {
    toolId: row.tool_id,
    serverId: row.server_id,
    name: row.name,
    description: row.description ?? undefined,
    inputSchema: JSON.parse(row.input_schema) as Record<string, unknown>,
    lastSynced: row.last_synced,
  };
}

export function normalizeMcpPrice(pricePerCall?: string): string {
  const price = pricePerCall?.trim();
  return price ? price : DEFAULT_PRICE_PER_CALL;
}

// ── Server CRUD ───────────────────────────────────────────────────────────────

export function createMcpServer(opts: {
  name: string;
  endpoint: string;
  description?: string;
  ownerAgentId?: string;
  pricePerCall?: string;
}): McpServer {
  const db = getDb();
  const serverId = randomUUID();
  const createdAt = new Date().toISOString();
  const pricePerCall = normalizeMcpPrice(opts.pricePerCall);

  db.prepare(`
    INSERT INTO mcp_servers (server_id, name, endpoint, description, owner_agent_id, price_per_call, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    serverId, opts.name, opts.endpoint,
    opts.description ?? null, opts.ownerAgentId ?? null,
    pricePerCall, createdAt
  );

  void syncToTurso();
  return getMcpServer(serverId)!;
}

export function getMcpServer(serverId: string): McpServer | null {
  const row = getDb()
    .prepare("SELECT * FROM mcp_servers WHERE server_id = ?")
    .get(serverId) as McpServerRow | undefined;
  return row ? rowToServer(row) : null;
}

export function getMcpServerByAgentId(agentId: string): McpServer | null {
  // MCP servers are registered as agents using their server_id as the agent_id
  return getMcpServer(agentId);
}

export function listMcpServers(status?: McpServer["status"]): McpServer[] {
  const db = getDb();
  const rows = status
    ? db.prepare("SELECT * FROM mcp_servers WHERE status = ? ORDER BY created_at DESC").all(status) as McpServerRow[]
    : db.prepare("SELECT * FROM mcp_servers ORDER BY created_at DESC").all() as McpServerRow[];
  return rows.map(rowToServer);
}

export function updateMcpServerStatus(serverId: string, status: McpServer["status"]): void {
  getDb()
    .prepare("UPDATE mcp_servers SET status = ? WHERE server_id = ?")
    .run(status, serverId);
}

export function deleteMcpServer(serverId: string): void {
  getDb().prepare("DELETE FROM mcp_servers WHERE server_id = ?").run(serverId);
}

// ── Tool queries ──────────────────────────────────────────────────────────────

export function getMcpToolsByServer(serverId: string): McpToolRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY name ASC")
    .all(serverId) as McpToolRow[];
  return rows.map(rowToTool);
}

export function getMcpTool(toolId: string): McpToolRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM mcp_tools WHERE tool_id = ?")
    .get(toolId) as McpToolRow | undefined;
  return row ? rowToTool(row) : null;
}

export function getMcpToolByName(serverId: string, name: string): McpToolRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM mcp_tools WHERE server_id = ? AND name = ?")
    .get(serverId, name) as McpToolRow | undefined;
  return row ? rowToTool(row) : null;
}

// ── Tool sync ─────────────────────────────────────────────────────────────────

export async function syncMcpTools(serverId: string): Promise<McpToolRecord[]> {
  const server = getMcpServer(serverId);
  if (!server) throw new Error(`MCP server '${serverId}' not found`);

  const client = new McpHttpClient(server.endpoint);
  let tools: McpTool[];
  try {
    tools = await client.listTools();
  } catch (err) {
    updateMcpServerStatus(serverId, "error");
    void syncToTurso();
    throw new Error(
      `Failed to fetch tools from '${server.name}': ${err instanceof Error ? err.message : "unknown"}`
    );
  }

  const db = getDb();
  const now = new Date().toISOString();

  db.transaction(() => {
    // Remove tools that no longer exist on the server
    const live = new Set(tools.map((t) => t.name));
    const stored = db
      .prepare("SELECT name FROM mcp_tools WHERE server_id = ?")
      .all(serverId) as { name: string }[];
    for (const { name } of stored) {
      if (!live.has(name)) {
        db.prepare("DELETE FROM mcp_tools WHERE server_id = ? AND name = ?").run(serverId, name);
      }
    }

    // Upsert current tools
    for (const tool of tools) {
      const existing = db
        .prepare("SELECT tool_id FROM mcp_tools WHERE server_id = ? AND name = ?")
        .get(serverId, tool.name) as { tool_id: string } | undefined;

      if (existing) {
        db.prepare(`
          UPDATE mcp_tools SET description = ?, input_schema = ?, last_synced = ?
          WHERE tool_id = ?
        `).run(tool.description ?? null, JSON.stringify(tool.inputSchema), now, existing.tool_id);
      } else {
        db.prepare(`
          INSERT INTO mcp_tools (tool_id, server_id, name, description, input_schema, last_synced)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), serverId, tool.name, tool.description ?? null, JSON.stringify(tool.inputSchema), now);
      }
    }
  })();

  updateMcpServerStatus(serverId, "active");
  void syncToTurso();
  return getMcpToolsByServer(serverId);
}

// ── Tool execution ────────────────────────────────────────────────────────────

export async function callMcpTool(
  toolId: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = getMcpTool(toolId);
  if (!tool) throw new Error(`MCP tool '${toolId}' not found`);

  const server = getMcpServer(tool.serverId);
  if (!server) throw new Error(`MCP server for tool '${tool.name}' not found`);
  if (server.status !== "active") {
    throw new Error(`MCP server '${server.name}' is not active (status: ${server.status})`);
  }

  // Validate required fields declared in the tool's inputSchema
  const schema = tool.inputSchema as { required?: string[] };
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    const missing = schema.required.filter((k) => !(k in args));
    if (missing.length > 0) {
      throw new Error(
        `MCP tool '${tool.name}' missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`
      );
    }
  }

  const client = new McpHttpClient(server.endpoint);
  const result = await client.callTool(tool.name, args);

  if (result.isError) {
    const errText = McpHttpClient.resultToText(result);
    throw new Error(`MCP tool '${tool.name}' returned an error: ${errText}`);
  }

  return McpHttpClient.resultToText(result);
}

// ── Worker handler factory ────────────────────────────────────────────────────
// Returns a task handler for an MCP-backed agent.
//
// Task format (two options):
//   1. JSON: {"tool":"<name>","args":{...}}  → calls the named tool with those args
//   2. Plain text                            → routed to the first tool; the text is
//      mapped to the first string property in its inputSchema, or "input" as fallback.

export function createMcpAgentHandler(serverId: string) {
  return async (taskText: string): Promise<string> => {
    const tools = getMcpToolsByServer(serverId);
    if (tools.length === 0) {
      throw new Error("No tools available on this MCP server — try syncing it first");
    }

    let toolName: string;
    let args: Record<string, unknown>;

    try {
      const parsed = JSON.parse(taskText) as { tool?: string; args?: Record<string, unknown> };
      if (typeof parsed.tool === "string" && parsed.tool) {
        toolName = parsed.tool;
        args = parsed.args ?? {};
      } else {
        // Valid JSON but no 'tool' key — route to first tool using the whole object as args
        toolName = tools[0].name;
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Plain text — route to first tool, map text to first string parameter
      const first = tools[0];
      toolName = first.name;
      const schema = first.inputSchema as {
        properties?: Record<string, { type: string }>;
      };
      const firstProp = schema.properties ? Object.keys(schema.properties)[0] : "input";
      args = { [firstProp]: taskText };
    }

    const tool = getMcpToolByName(serverId, toolName);
    if (!tool) {
      const available = tools.map((t) => `'${t.name}'`).join(", ");
      throw new Error(`Tool '${toolName}' not found. Available tools: ${available}`);
    }

    return callMcpTool(tool.toolId, args);
  };
}
