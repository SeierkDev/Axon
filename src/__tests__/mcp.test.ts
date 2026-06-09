// Tests for src/lib/mcp.ts
// McpHttpClient is mocked — no real HTTP calls are made

import { vi, describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";

// Hoist mock refs so they are available inside vi.mock factory (hoisted before imports)
const { mockListTools, mockCallTool } = vi.hoisted(() => ({
  mockListTools: vi.fn(),
  mockCallTool: vi.fn(),
}));

vi.mock("@/lib/mcp-client", () => {
  // Mirror the real resultToText logic so callMcpTool return values are testable
  function resultToText(result: {
    content: Array<{ type: string; text?: string; mimeType?: string; resource?: { uri: string } }>;
  }): string {
    if (result.content.length === 0) return "(no output)";
    return result.content
      .map((c) => {
        if (c.type === "text") return c.text ?? "";
        if (c.type === "image") return `[Image: ${c.mimeType}]`;
        return `[Resource: ${(c as { resource: { uri: string } }).resource.uri}]`;
      })
      .join("\n")
      .trim();
  }

  // Must use a regular function (not arrow) so `new McpHttpClient(...)` works
  const Ctor = vi.fn(function () {
    return { listTools: mockListTools, callTool: mockCallTool };
  });
  (Ctor as unknown as { resultToText: typeof resultToText }).resultToText = resultToText;
  return { McpHttpClient: Ctor };
});

import {
  createMcpServer,
  getMcpServer,
  getMcpServerByAgentId,
  listMcpServers,
  updateMcpServerStatus,
  deleteMcpServer,
  getMcpToolsByServer,
  getMcpTool,
  getMcpToolByName,
  syncMcpTools,
  callMcpTool,
  createMcpAgentHandler,
  normalizeMcpPrice,
} from "@/lib/mcp";

beforeEach(() => {
  vi.clearAllMocks();
});

// Seed a tool row directly — avoids coupling non-sync tests to syncMcpTools
function seedTool(
  serverId: string,
  name: string,
  schema: Record<string, unknown> = {}
): string {
  const toolId = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO mcp_tools (tool_id, server_id, name, description, input_schema, last_synced)
       VALUES (?, ?, ?, NULL, ?, ?)`
    )
    .run(toolId, serverId, name, JSON.stringify(schema), new Date().toISOString());
  return toolId;
}

function makeServer(
  overrides: Partial<{
    name: string;
    endpoint: string;
    description: string;
    ownerAgentId: string;
    pricePerCall: string;
  }> = {}
) {
  return createMcpServer({
    name: "Test Server",
    endpoint: "https://mcp.example.com/",
    ...overrides,
  });
}

// ── normalizeMcpPrice ──────────────────────────────────────────────────────────

describe("normalizeMcpPrice", () => {
  it("returns the provided price when set", () => {
    expect(normalizeMcpPrice("0.05 USDC")).toBe("0.05 USDC");
  });

  it("returns the default when undefined, empty, or whitespace", () => {
    expect(normalizeMcpPrice(undefined)).toBe("0.10 USDC");
    expect(normalizeMcpPrice("")).toBe("0.10 USDC");
    expect(normalizeMcpPrice("   ")).toBe("0.10 USDC");
  });
});

// ── createMcpServer ────────────────────────────────────────────────────────────

describe("createMcpServer", () => {
  it("creates a server with expected fields and active status", () => {
    const s = makeServer({ name: "My Server", description: "does stuff" });
    expect(s.serverId).toBeTruthy();
    expect(s.name).toBe("My Server");
    expect(s.description).toBe("does stuff");
    expect(s.status).toBe("active");
    expect(s.pricePerCall).toBe("0.10 USDC");
    expect(s.createdAt).toBeTruthy();
  });

  it("stores a custom pricePerCall", () => {
    const s = makeServer({ pricePerCall: "0.02 USDC" });
    expect(s.pricePerCall).toBe("0.02 USDC");
  });

  it("stores ownerAgentId when provided", () => {
    const s = makeServer({ ownerAgentId: "owner-agent-1" });
    expect(s.ownerAgentId).toBe("owner-agent-1");
  });
});

// ── getMcpServer ───────────────────────────────────────────────────────────────

describe("getMcpServer", () => {
  it("returns the server by ID", () => {
    const s = makeServer();
    const found = getMcpServer(s.serverId);
    expect(found).not.toBeNull();
    expect(found!.serverId).toBe(s.serverId);
  });

  it("returns null for an unknown ID", () => {
    expect(getMcpServer("no-such-server")).toBeNull();
  });
});

// ── getMcpServerByAgentId ──────────────────────────────────────────────────────

describe("getMcpServerByAgentId", () => {
  it("delegates to getMcpServer using the agent ID as the server ID", () => {
    const s = makeServer();
    const found = getMcpServerByAgentId(s.serverId);
    expect(found).not.toBeNull();
    expect(found!.serverId).toBe(s.serverId);
  });
});

// ── listMcpServers ─────────────────────────────────────────────────────────────

describe("listMcpServers", () => {
  it("returns all servers without a filter", () => {
    const s1 = makeServer({ name: "List A" });
    const s2 = makeServer({ name: "List B" });
    const ids = listMcpServers().map((s) => s.serverId);
    expect(ids).toContain(s1.serverId);
    expect(ids).toContain(s2.serverId);
  });

  it("filters by status", () => {
    const s = makeServer({ name: "StatusFilter" });
    updateMcpServerStatus(s.serverId, "inactive");
    expect(listMcpServers("active").some((x) => x.serverId === s.serverId)).toBe(false);
    expect(listMcpServers("inactive").some((x) => x.serverId === s.serverId)).toBe(true);
  });
});

// ── updateMcpServerStatus ──────────────────────────────────────────────────────

describe("updateMcpServerStatus", () => {
  it("toggles status between active and inactive", () => {
    const s = makeServer();
    updateMcpServerStatus(s.serverId, "inactive");
    expect(getMcpServer(s.serverId)!.status).toBe("inactive");
    updateMcpServerStatus(s.serverId, "active");
    expect(getMcpServer(s.serverId)!.status).toBe("active");
  });

  it("can set status to 'error'", () => {
    const s = makeServer();
    updateMcpServerStatus(s.serverId, "error");
    expect(getMcpServer(s.serverId)!.status).toBe("error");
  });
});

// ── deleteMcpServer ────────────────────────────────────────────────────────────

describe("deleteMcpServer", () => {
  it("removes the server from the database", () => {
    const s = makeServer();
    deleteMcpServer(s.serverId);
    expect(getMcpServer(s.serverId)).toBeNull();
  });
});

// ── getMcpToolsByServer ────────────────────────────────────────────────────────

describe("getMcpToolsByServer", () => {
  it("returns an empty array when the server has no tools", () => {
    const s = makeServer();
    expect(getMcpToolsByServer(s.serverId)).toEqual([]);
  });

  it("returns tools ordered alphabetically by name", () => {
    const s = makeServer();
    seedTool(s.serverId, "z-tool");
    seedTool(s.serverId, "a-tool");
    const tools = getMcpToolsByServer(s.serverId);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("a-tool");
    expect(tools[1].name).toBe("z-tool");
  });
});

// ── getMcpTool ─────────────────────────────────────────────────────────────────

describe("getMcpTool", () => {
  it("returns a tool by ID", () => {
    const s = makeServer();
    const toolId = seedTool(s.serverId, "my-tool");
    const tool = getMcpTool(toolId);
    expect(tool).not.toBeNull();
    expect(tool!.toolId).toBe(toolId);
    expect(tool!.name).toBe("my-tool");
    expect(tool!.serverId).toBe(s.serverId);
  });

  it("returns null for an unknown tool ID", () => {
    expect(getMcpTool("no-such-tool")).toBeNull();
  });
});

// ── getMcpToolByName ───────────────────────────────────────────────────────────

describe("getMcpToolByName", () => {
  it("returns a tool by server ID and name", () => {
    const s = makeServer();
    seedTool(s.serverId, "named-tool");
    const tool = getMcpToolByName(s.serverId, "named-tool");
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("named-tool");
  });

  it("returns null when the name does not match", () => {
    const s = makeServer();
    expect(getMcpToolByName(s.serverId, "ghost-tool")).toBeNull();
  });
});

// ── syncMcpTools ───────────────────────────────────────────────────────────────

describe("syncMcpTools: inserts all tools returned by the remote server", () => {
  it("creates tool records and marks server active", async () => {
    const s = makeServer();
    mockListTools.mockResolvedValueOnce([
      { name: "search",    description: "Search the web", inputSchema: { type: "object" } },
      { name: "summarize", description: "Summarize text", inputSchema: { type: "object" } },
    ]);

    const tools = await syncMcpTools(s.serverId);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["search", "summarize"]);
    expect(getMcpServer(s.serverId)!.status).toBe("active");
  });
});

describe("syncMcpTools: removes tools no longer on the remote server", () => {
  it("deletes stale tools on a re-sync", async () => {
    const s = makeServer();

    // First sync — 2 tools
    mockListTools.mockResolvedValueOnce([
      { name: "alpha", description: null, inputSchema: {} },
      { name: "beta",  description: null, inputSchema: {} },
    ]);
    await syncMcpTools(s.serverId);
    expect(getMcpToolsByServer(s.serverId)).toHaveLength(2);

    // Second sync — alpha only; beta must be removed
    mockListTools.mockResolvedValueOnce([
      { name: "alpha", description: null, inputSchema: {} },
    ]);
    const tools = await syncMcpTools(s.serverId);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("alpha");
    expect(getMcpToolByName(s.serverId, "beta")).toBeNull();
  });
});

describe("syncMcpTools: marks server as error on listTools failure", () => {
  it("sets status to 'error' and re-throws", async () => {
    const s = makeServer();
    mockListTools.mockRejectedValueOnce(new Error("connection refused"));

    await expect(syncMcpTools(s.serverId)).rejects.toThrow(/connection refused/);
    expect(getMcpServer(s.serverId)!.status).toBe("error");
  });
});

describe("syncMcpTools: unknown server", () => {
  it("throws immediately when the server ID does not exist", async () => {
    await expect(syncMcpTools("no-such-server")).rejects.toThrow(/not found/);
  });
});

// ── callMcpTool ────────────────────────────────────────────────────────────────

describe("callMcpTool: happy path", () => {
  it("calls the tool and returns the text output", async () => {
    const s = makeServer();
    const toolId = seedTool(s.serverId, "greet", {
      type: "object",
      properties: { name: { type: "string" } },
    });

    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hello, world!" }],
      isError: false,
    });

    const result = await callMcpTool(toolId, { name: "world" });
    expect(result).toBe("Hello, world!");
    expect(mockCallTool).toHaveBeenCalledWith("greet", { name: "world" });
  });
});

describe("callMcpTool: tool not found", () => {
  it("throws when the toolId does not exist", async () => {
    await expect(callMcpTool("no-such-tool", {})).rejects.toThrow(/not found/);
  });
});

describe("callMcpTool: server not active", () => {
  it("throws when the server status is not 'active'", async () => {
    const s = makeServer();
    const toolId = seedTool(s.serverId, "inactive-tool");
    updateMcpServerStatus(s.serverId, "error");

    await expect(callMcpTool(toolId, {})).rejects.toThrow(/not active/);
  });
});

describe("callMcpTool: missing required arguments", () => {
  it("throws listing the missing required fields from inputSchema", async () => {
    const s = makeServer();
    const toolId = seedTool(s.serverId, "strict-tool", {
      type: "object",
      required: ["city", "country"],
      properties: {
        city:    { type: "string" },
        country: { type: "string" },
      },
    });

    // Provide city but not country
    await expect(callMcpTool(toolId, { city: "Oslo" })).rejects.toThrow(/country/);
  });
});

describe("callMcpTool: error result from the tool", () => {
  it("throws when the tool returns isError: true", async () => {
    const s = makeServer();
    const toolId = seedTool(s.serverId, "failing-tool");

    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "something went wrong" }],
      isError: true,
    });

    await expect(callMcpTool(toolId, {})).rejects.toThrow(/returned an error/);
  });
});

// ── createMcpAgentHandler ──────────────────────────────────────────────────────

describe("createMcpAgentHandler: JSON routing with explicit tool name", () => {
  it("calls the named tool with the provided args", async () => {
    const s = makeServer();
    seedTool(s.serverId, "calculate", {
      type: "object",
      properties: { expr: { type: "string" } },
    });

    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "42" }],
      isError: false,
    });

    const handler = createMcpAgentHandler(s.serverId);
    const result = await handler(JSON.stringify({ tool: "calculate", args: { expr: "6*7" } }));
    expect(result).toBe("42");
    expect(mockCallTool).toHaveBeenCalledWith("calculate", { expr: "6*7" });
  });
});

describe("createMcpAgentHandler: plain text routing", () => {
  it("maps plain text to the first string property of the first tool", async () => {
    const s = makeServer();
    seedTool(s.serverId, "echo", {
      type: "object",
      properties: { message: { type: "string" } },
    });

    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "hello back" }],
      isError: false,
    });

    const handler = createMcpAgentHandler(s.serverId);
    const result = await handler("hello");
    expect(result).toBe("hello back");
    expect(mockCallTool).toHaveBeenCalledWith("echo", { message: "hello" });
  });
});

describe("createMcpAgentHandler: no tools available", () => {
  it("throws when the server has no tools", async () => {
    const s = makeServer();
    const handler = createMcpAgentHandler(s.serverId);
    await expect(handler("do something")).rejects.toThrow(/No tools available/);
  });
});

describe("createMcpAgentHandler: named tool not found", () => {
  it("throws and includes the tool name in the error message", async () => {
    const s = makeServer();
    seedTool(s.serverId, "real-tool");

    const handler = createMcpAgentHandler(s.serverId);
    await expect(
      handler(JSON.stringify({ tool: "ghost-tool", args: {} }))
    ).rejects.toThrow(/ghost-tool/);
  });
});
