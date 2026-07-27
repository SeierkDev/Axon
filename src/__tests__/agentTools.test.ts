// Tests for src/lib/agentTools.ts — grant validation, resolution into runnable
// tools, and the agents-table round trip. No network: MCP servers and their
// tools are seeded straight into the DB.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { createMcpServer, updateMcpServerStatus } from "@/lib/mcp";
import { createAgent, getAgentById, getAllAgents, updateAgent } from "@/lib/agents";
import { getBuiltinAgent } from "@/lib/agentSeed";
import { effectiveModel } from "@/lib/providers";
import {
  validateToolGrants,
  normalizeToolGrants,
  parseToolsColumn,
  resolveAgentTools,
  hasTools,
  describeToolGrant,
  MAX_TOOL_GRANTS,
  MAX_LOCAL_TOOLS,
  modelSupportsServerTools,
  usesServerTools,
  toolsActiveFor,
} from "@/lib/agentTools";
import type { Agent } from "@/sdk/types";

const TEST_WALLET = "11111111111111111111111111111111";

function seedServer(name: string, toolNames: string[]) {
  const server = createMcpServer({ name, endpoint: "https://mcp.example.com/rpc" });
  const db = getDb();
  for (const toolName of toolNames) {
    db.prepare(
      `INSERT INTO mcp_tools (tool_id, server_id, name, description, input_schema, last_synced)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      server.serverId,
      toolName,
      `does ${toolName}`,
      JSON.stringify({ type: "object", properties: { q: { type: "string" } } }),
      new Date().toISOString(),
    );
  }
  return server;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: `tools-${randomUUID().slice(0, 8)}`,
    name: "Tools Agent",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 8)}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

describe("validateToolGrants", () => {
  it("accepts the built-in grants", () => {
    expect(validateToolGrants(["web_search", "web_fetch"])).toBeNull();
  });

  it("rejects an unknown grant by name", () => {
    expect(validateToolGrants(["shell"])).toMatch(/unknown tool grant 'shell'/);
  });

  it("rejects an MCP grant pointing at a server that isn't registered", () => {
    expect(validateToolGrants(["mcp:does-not-exist"])).toMatch(/not registered on Axon/);
  });

  it("accepts an MCP grant for a registered server", () => {
    const server = seedServer(`Registered ${randomUUID().slice(0, 6)}`, ["lookup"]);
    expect(validateToolGrants([`mcp:${server.serverId}`])).toBeNull();
  });

  it("caps how many grants one agent can hold", () => {
    const many = Array.from({ length: MAX_TOOL_GRANTS + 1 }, () => "web_search");
    expect(validateToolGrants(many)).toMatch(new RegExp(`${MAX_TOOL_GRANTS} or fewer`));
  });

  it("rejects blank entries", () => {
    expect(validateToolGrants(["web_search", "   "])).toMatch(/must not contain empty entries/);
  });
});

describe("normalizeToolGrants / parseToolsColumn", () => {
  it("trims, drops blanks, and de-duplicates", () => {
    expect(normalizeToolGrants([" web_search ", "web_search", "", "web_fetch"])).toEqual([
      "web_search",
      "web_fetch",
    ]);
  });

  it("treats a corrupt or absent column as no tools", () => {
    expect(parseToolsColumn(null)).toEqual([]);
    expect(parseToolsColumn("not json")).toEqual([]);
    expect(parseToolsColumn('{"nope":1}')).toEqual([]);
    expect(parseToolsColumn('["web_search", 7]')).toEqual(["web_search"]);
  });
});

// ── Resolution ────────────────────────────────────────────────────────────────

describe("resolveAgentTools", () => {
  it("turns the built-ins into Anthropic-executed tool definitions", () => {
    const resolved = resolveAgentTools(["web_search", "web_fetch"]);
    expect(resolved.serverTools.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
    expect(resolved.localTools).toHaveLength(0);
    expect(hasTools(resolved)).toBe(true);
  });

  it("loads every synced tool from a granted MCP server, namespaced", () => {
    const server = seedServer(`Analyst ${randomUUID().slice(0, 6)}`, ["lookup", "compute totals"]);
    const resolved = resolveAgentTools([`mcp:${server.serverId}`]);

    expect(resolved.localTools).toHaveLength(2);
    // Names are sanitized to what the model API accepts, and prefixed per server.
    for (const tool of resolved.localTools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      expect(tool.name.startsWith("mcp_")).toBe(true);
    }
    // The receipt-facing label stays readable.
    expect(resolved.localTools.map((t) => t.label).sort()).toEqual(
      [`${server.name}/compute totals`, `${server.name}/lookup`].sort(),
    );
    expect(resolved.grants).toEqual([`mcp:${server.serverId}`]);
  });

  it("keeps tool names unique when two sanitize to the same string", () => {
    // "compute totals" and "compute.totals" both sanitize to "compute_totals".
    // The API rejects a duplicate tool name outright, which would drop the whole
    // kit — so one oddly-named tool must not disable the rest.
    const server = seedServer(`Collide ${randomUUID().slice(0, 6)}`, ["compute totals", "compute.totals"]);
    const names = resolveAgentTools([`mcp:${server.serverId}`]).localTools.map((t) => t.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it("skips an inactive server rather than throwing", () => {
    const server = seedServer(`Down ${randomUUID().slice(0, 6)}`, ["lookup"]);
    updateMcpServerStatus(server.serverId, "error");
    const resolved = resolveAgentTools(["web_search", `mcp:${server.serverId}`]);
    expect(resolved.localTools).toHaveLength(0);
    expect(resolved.grants).toEqual(["web_search"]);
  });

  it("skips a stale grant for a deleted server, keeping the rest of the kit", () => {
    const resolved = resolveAgentTools(["mcp:gone-forever", "web_search"]);
    expect(resolved.grants).toEqual(["web_search"]);
    expect(hasTools(resolved)).toBe(true);
  });

  it("caps how many MCP tool schemas load into one request", () => {
    const names = Array.from({ length: MAX_LOCAL_TOOLS + 5 }, (_, i) => `tool${i}`);
    const server = seedServer(`Huge ${randomUUID().slice(0, 6)}`, names);
    expect(resolveAgentTools([`mcp:${server.serverId}`]).localTools).toHaveLength(MAX_LOCAL_TOOLS);
  });

  it("reports no tools for an empty grant list", () => {
    expect(hasTools(resolveAgentTools([]))).toBe(false);
  });
});

describe("modelSupportsServerTools", () => {
  it("rejects models that predate the server-side web tools", () => {
    // Granting web tools on one of these is a 400 on every task, which the
    // runtime absorbs into a silent tool-free answer — so it has to be caught
    // while the owner is still there to fix it.
    for (const m of ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1"]) {
      expect(modelSupportsServerTools(m)).toBe(false);
    }
  });

  it("accepts current models, and anything unrecognised", () => {
    for (const m of ["claude-sonnet-5", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-4-6", "claude-future-9"]) {
      expect(modelSupportsServerTools(m)).toBe(true);
    }
    // No pin at all means the platform default, which supports them.
    expect(modelSupportsServerTools(undefined)).toBe(true);
    expect(modelSupportsServerTools(null)).toBe(true);
  });

  it("the platform default model can run the web tools", () => {
    // An unpinned agent (research-agent, web-agent, and anything registered
    // without providerModel) inherits this. modelSupportsServerTools can't see
    // it — so if the default is ever dropped to something cheaper, this is the
    // thing that fails instead of every unpinned granted agent going quietly
    // tool-free in production.
    const platformDefault = effectiveModel(
      { agentId: "x", name: "x", capabilities: [], publicKey: "x", provider: "anthropic", createdAt: "" },
      null,
    );
    expect(platformDefault).toBeTruthy();
    expect({ model: platformDefault, runsTools: modelSupportsServerTools(platformDefault) }).toEqual({
      model: platformDefault,
      runsTools: true,
    });
  });

  it("only the web grants care about the model", () => {
    expect(usesServerTools(["web_search"])).toBe(true);
    expect(usesServerTools(["web_fetch"])).toBe(true);
    expect(usesServerTools(["mcp:srv-1"])).toBe(false);
    expect(usesServerTools([])).toBe(false);
  });
});

describe("describeToolGrant", () => {
  it("names the built-ins and resolves an MCP server to its name", () => {
    const server = seedServer(`Named ${randomUUID().slice(0, 6)}`, ["lookup"]);
    expect(describeToolGrant("web_search")).toBe("Web search");
    expect(describeToolGrant(`mcp:${server.serverId}`)).toBe(server.name);
  });
});

// ── Platform agents ───────────────────────────────────────────────────────────

describe("built-in platform agents", () => {
  it("gives the web-facing agents live web tools, and resolves them", () => {
    for (const id of ["research-agent", "web-agent"]) {
      // Seeded by getDb() on boot; the DB-free definition must agree with the row.
      expect(getBuiltinAgent(id)?.tools).toEqual(["web_search", "web_fetch"]);
      expect(getAgentById(id)?.tools).toEqual(["web_search", "web_fetch"]);

      const resolved = resolveAgentTools(getAgentById(id)!.tools!);
      expect(resolved.serverTools.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
      expect(hasTools(resolved)).toBe(true);
    }
  });

  it("leaves every other platform agent on the single-call path", () => {
    for (const id of ["content-agent", "code-agent", "trading-agent"]) {
      expect(getAgentById(id)?.tools).toEqual([]);
    }
  });

  it("every granted platform agent can actually run what it was granted", () => {
    // The guard against the seed table drifting into a broken pairing: a grant
    // beside a model that can't run it 400s on every task and degrades to a
    // tool-free answer, which nothing in production would surface.
    const granted = getAllAgents().filter((a) => a.tools?.length);
    expect(granted.length).toBeGreaterThan(0);
    for (const agent of granted) {
      expect({ id: agent.agentId, active: toolsActiveFor(agent) }).toEqual({
        id: agent.agentId,
        active: true,
      });
    }
  });
});

describe("toolsActiveFor", () => {
  const base = { provider: "anthropic", tools: ["web_search"] };

  it("is true for a hosted Anthropic agent on a capable model", () => {
    expect(toolsActiveFor(base)).toBe(true);
    expect(toolsActiveFor({ ...base, providerModel: "claude-sonnet-5" })).toBe(true);
  });

  it("is false wherever the grant cannot actually run", () => {
    expect(toolsActiveFor({ ...base, tools: [] })).toBe(false);
    expect(toolsActiveFor({ ...base, endpoint: "https://x.example" })).toBe(false);
    expect(toolsActiveFor({ ...base, provider: "grok" })).toBe(false);
    expect(toolsActiveFor({ ...base, providerModel: "claude-haiku-4-5" })).toBe(false);
  });

  it("stays true for an MCP grant on a model without server-tool support", () => {
    // Axon executes MCP tools itself, so the model restriction doesn't apply.
    expect(toolsActiveFor({ provider: "anthropic", tools: ["mcp:srv-1"], providerModel: "claude-haiku-4-5" })).toBe(true);
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe("agents table round trip", () => {
  it("stores grants on register and reads them back", () => {
    const agent = createAgent(makeAgent({ tools: ["web_search", "web_fetch"] }));
    expect(getAgentById(agent.agentId)?.tools).toEqual(["web_search", "web_fetch"]);
  });

  it("defaults to no tools — the previous single-call behaviour", () => {
    const agent = createAgent(makeAgent());
    expect(getAgentById(agent.agentId)?.tools).toEqual([]);
  });

  it("replaces the whole grant set on update", () => {
    const agent = createAgent(makeAgent({ tools: ["web_search"] }));
    updateAgent(agent.agentId, { tools: ["web_fetch"] });
    expect(getAgentById(agent.agentId)?.tools).toEqual(["web_fetch"]);
  });

  it("revokes every tool when passed an empty list", () => {
    const agent = createAgent(makeAgent({ tools: ["web_search", "web_fetch"] }));
    updateAgent(agent.agentId, { tools: [] });
    expect(getAgentById(agent.agentId)?.tools).toEqual([]);
  });

  it("leaves grants alone when the update doesn't mention them", () => {
    const agent = createAgent(makeAgent({ tools: ["web_search"] }));
    updateAgent(agent.agentId, { name: "Renamed" });
    const after = getAgentById(agent.agentId);
    expect(after?.name).toBe("Renamed");
    expect(after?.tools).toEqual(["web_search"]);
  });
});
