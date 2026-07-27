// Agent tool grants — what a hosted agent is allowed to reach for.
//
// A grant is a short string stored on the agent (agents.tools, JSON array):
//
//   "web_search"      live web search, executed on Anthropic's side
//   "web_fetch"       fetch a URL already present in the conversation
//   "mcp:<serverId>"  every tool exposed by an MCP server registered on Axon
//
// This module turns those grants into the two things the inference layer needs:
// server-side tool definitions (Anthropic runs them) and local tools (we run
// them, against the MCP server). Resolution is deliberately forgiving — a grant
// pointing at a deleted or unsynced MCP server is dropped with a log line, never
// an exception, because a stale grant must not fail a paid task.

import type Anthropic from "@anthropic-ai/sdk";
import { getMcpServer, getMcpToolsByServer, callMcpTool } from "./mcp";
import { logger } from "./logger";

// ── Limits ────────────────────────────────────────────────────────────────────
// Defined in ./agentToolLimits so the inference layer can read them without
// importing the DB; re-exported here so callers have one tool surface to import.

import { MAX_TOOL_GRANTS, MAX_LOCAL_TOOLS } from "./agentToolLimits";
export { MAX_TOOL_GRANTS, MAX_TOOL_STEPS, MAX_LOCAL_TOOLS, MAX_TOOL_RESULT_CHARS } from "./agentToolLimits";

export const BUILTIN_TOOL_GRANTS = ["web_search", "web_fetch"] as const;
export type BuiltinToolGrant = (typeof BUILTIN_TOOL_GRANTS)[number];

const MCP_GRANT = /^mcp:([A-Za-z0-9_-]{1,80})$/;

// Models that predate the server-side web tools. Pinning an agent to one of
// these and granting web_search/web_fetch is a 400 on every single task — the
// runtime falls back to a tool-free answer, so the owner would never find out
// their agent silently lost the capability they asked for. Catch it while
// they're still at the keyboard.
//
// A denylist, not an allowlist, on purpose: an unrecognised (newer) model is
// assumed to work, and the request-rejected fallback in providers.ts is the
// backstop if that bet is ever wrong. An allowlist would reject every model
// released after this line was written.
const MODELS_WITHOUT_SERVER_TOOLS = [
  "claude-haiku",
  "claude-3",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-opus-4-5",
];

/**
 * Whether this model can run the Anthropic-executed web tools.
 *
 * An unpinned agent takes the platform default from providers.ts, which today
 * supports them — a coupling this module can't see, so a test pins it. Drop the
 * default to a cheaper model and every unpinned granted agent would break here
 * silently; that test is what makes it fail loudly instead.
 */
export function modelSupportsServerTools(model?: string | null): boolean {
  if (!model) return true;
  return !MODELS_WITHOUT_SERVER_TOOLS.some((p) => model.startsWith(p));
}

/** The web grants, i.e. the ones that need a model with server-tool support. */
export function usesServerTools(grants: string[]): boolean {
  return grants.some((g) => g === "web_search" || g === "web_fetch");
}

// ── Grant parsing / validation ────────────────────────────────────────────────

/** Human-readable reason a grant list is invalid, or null when it's fine. */
export function validateToolGrants(grants: string[]): string | null {
  if (grants.length > MAX_TOOL_GRANTS) {
    return `tools must contain ${MAX_TOOL_GRANTS} or fewer grants`;
  }
  for (const raw of grants) {
    const g = raw.trim();
    if (!g) return "tools must not contain empty entries";
    if ((BUILTIN_TOOL_GRANTS as readonly string[]).includes(g)) continue;
    const m = MCP_GRANT.exec(g);
    if (!m) {
      return `unknown tool grant '${g}' — use ${BUILTIN_TOOL_GRANTS.join(", ")}, or mcp:<serverId>`;
    }
    if (!getMcpServer(m[1])) {
      return `MCP server '${m[1]}' is not registered on Axon`;
    }
  }
  return null;
}

/** Trim, drop blanks, de-duplicate — the form that gets stored. */
export function normalizeToolGrants(grants: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of grants) {
    const g = raw.trim();
    if (!g || seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out;
}

/** Parse the stored JSON column. Never throws — a corrupt value means no tools. */
export function parseToolsColumn(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeToolGrants(parsed.filter((g): g is string => typeof g === "string"));
  } catch {
    return [];
  }
}

// ── Resolution ────────────────────────────────────────────────────────────────

export interface LocalTool {
  /** The name the model sees. Namespaced so two MCP servers can't collide. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Label used in the receipt trace — readable, not the internal id. */
  label: string;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface ResolvedTools {
  /** Anthropic-executed tools (web search / fetch), passed straight through. */
  serverTools: Anthropic.Messages.ToolUnion[];
  /** Tools we execute ourselves, currently MCP-backed. */
  localTools: LocalTool[];
  /** The grants that actually resolved — what the agent really has tonight. */
  grants: string[];
}

export function hasTools(t: ResolvedTools | null | undefined): t is ResolvedTools {
  return !!t && (t.serverTools.length > 0 || t.localTools.length > 0);
}

// Anthropic tool names accept [a-zA-Z0-9_-] only. MCP servers are free to use
// anything, so sanitize and namespace rather than trusting the remote name.
//
// Sanitizing can collide — "compute totals" and "compute.totals" both become
// "compute_totals" — and the API rejects a duplicate tool name outright, which
// would drop the agent's ENTIRE kit over one oddly-named tool. `taken` keeps the
// names unique so both stay callable.
function toolNameFor(serverId: string, toolName: string, taken: Set<string>): string {
  const safeServer = serverId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  const safeTool = toolName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const base = `mcp_${safeServer}_${safeTool}`.slice(0, 128);
  let name = base;
  for (let n = 2; taken.has(name); n++) {
    const suffix = `_${n}`;
    name = `${base.slice(0, 128 - suffix.length)}${suffix}`;
  }
  taken.add(name);
  return name;
}

// The model needs a JSON-Schema object. MCP servers occasionally hand back
// something looser; coerce rather than reject, so one odd tool can't strip a
// whole server out of the agent's kit.
function toInputSchema(schema: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (schema && schema.type === "object") return schema;
  const properties = schema && typeof schema.properties === "object" ? schema.properties : {};
  return { ...(schema ?? {}), type: "object", properties };
}

/**
 * Turn stored grants into runnable tools. Unknown or unavailable grants are
 * skipped, so this always returns something usable.
 */
export function resolveAgentTools(grants: string[]): ResolvedTools {
  const serverTools: Anthropic.Messages.ToolUnion[] = [];
  const localTools: LocalTool[] = [];
  const resolved: string[] = [];
  const takenNames = new Set<string>();

  for (const grant of normalizeToolGrants(grants)) {
    // No per-tool use or content caps: the agent searches and reads as much as
    // the job actually needs. The tool loop's step bound still terminates it.
    if (grant === "web_search") {
      serverTools.push({ type: "web_search_20260209", name: "web_search" });
      resolved.push(grant);
      continue;
    }
    if (grant === "web_fetch") {
      serverTools.push({ type: "web_fetch_20260209", name: "web_fetch" });
      resolved.push(grant);
      continue;
    }

    const m = MCP_GRANT.exec(grant);
    if (!m) {
      logger.warn("agentTools.unknown_grant", "Ignoring unrecognised tool grant", { grant });
      continue;
    }
    const serverId = m[1];
    const server = getMcpServer(serverId);
    if (!server || server.status !== "active") {
      logger.warn("agentTools.server_unavailable", "Skipping MCP grant — server missing or inactive", {
        grant,
        status: server?.status ?? "missing",
      });
      continue;
    }

    const tools = getMcpToolsByServer(serverId);
    if (tools.length === 0) {
      logger.warn("agentTools.server_empty", "Skipping MCP grant — no synced tools", { grant, server: server.name });
      continue;
    }

    let added = 0;
    for (const tool of tools) {
      if (localTools.length >= MAX_LOCAL_TOOLS) break;
      const toolId = tool.toolId;
      localTools.push({
        name: toolNameFor(serverId, tool.name, takenNames),
        description: tool.description ?? `${tool.name} — exposed by the '${server.name}' MCP server.`,
        inputSchema: toInputSchema(tool.inputSchema),
        label: `${server.name}/${tool.name}`,
        run: (args) => callMcpTool(toolId, args),
      });
      added++;
    }
    // Only claim the grant resolved if it actually contributed a tool — hitting
    // the schema cap means this server brought nothing to this request.
    if (added > 0) resolved.push(grant);
    else logger.warn("agentTools.schema_cap", "Skipping MCP grant — tool schema cap already reached", { grant });
  }

  return { serverTools, localTools, grants: resolved };
}

/**
 * Whether an agent's granted tools will actually run, mirroring the conditions
 * in runWithProviderTools. Grants are allowed on providers that can't use them
 * yet (set the field early, it starts working when support lands) — so anything
 * showing them publicly has to say which of the two it is, or it advertises a
 * capability the agent doesn't have.
 */
export function toolsActiveFor(agent: {
  provider?: string;
  endpoint?: string;
  providerModel?: string;
  tools?: string[];
}): boolean {
  if (!agent.tools?.length) return false;
  if (agent.endpoint) return false; // runs its own inference; the worker skips it
  if ((agent.provider ?? "anthropic") !== "anthropic") return false;
  if (usesServerTools(agent.tools) && !modelSupportsServerTools(agent.providerModel)) return false;
  return true;
}

/** One-line summary for the agent page / API. */
export function describeToolGrant(grant: string): string {
  if (grant === "web_search") return "Web search";
  if (grant === "web_fetch") return "Web fetch";
  const m = MCP_GRANT.exec(grant);
  if (m) return getMcpServer(m[1])?.name ?? `MCP server ${m[1]}`;
  return grant;
}
