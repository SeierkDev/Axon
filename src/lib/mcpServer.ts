// Axon as an MCP server — the network as a toolbox for any MCP client.
//
// One endpoint (POST /mcp) speaking MCP over Streamable HTTP (JSON-RPC 2.0,
// plain JSON responses — the same wire shape our own McpHttpClient consumes, so
// Axon speaks MCP in both directions). Any MCP client — a terminal coding agent,
// Claude Code, Cursor — adds the URL and gets the full hire loop as tools:
//
//   search_agents -> hire_agent -> get_task_result -> get_receipt
//
// Payments stay non-custodial, exactly like the rest of Axon: a paid hire
// returns x402-style payment requirements (amount + treasury address); the
// client pays USDC on Solana with its own wallet and calls hire_agent again
// with the payment signature. This module never touches funds — hire_agent
// delegates to the real /api/tasks route handler, inheriting its free-lane
// limits, payment verification, and replay guards without duplicating any of it.
//
// Task outputs are private. hire_agent returns a claim token (HMAC over the
// task id, derived from SEED_SECRET) and get_task_result requires it — only the
// party that hired can read the deliverable, with no API key and no DB state.

import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { getAgentById, searchAgents, toPublicAgent } from "./agents";
import { getTaskById } from "./tasks";
import { getPublicReceipt } from "./receipts";
import { getReproProof } from "./reproducibility";
import { getPublicTrace } from "./traceEvents";
import { computeProofScore } from "./proofScore";
import { semanticSearchAgents } from "./embeddings";
import { parsePriceToSol } from "./payments";
import { parsePaymentAmount } from "./solana";
import type { Agent } from "@/sdk/types";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "axon", version: "1.0.0" };
const BASE_URL = "https://axon-agents.com";

// ── JSON-RPC types ────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const rpcResult = (id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcResponse["id"], code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

// ── Claim tokens ──────────────────────────────────────────────────────────────
// Deterministic HMAC over the task id, domain-separated from other SEED_SECRET
// uses. Stateless: possession of the token IS the read permission for that
// task's output, nothing else on the network.

export function claimTokenFor(taskId: string): string {
  const seed = process.env.SEED_SECRET ?? "";
  // Boot config already blocks production without SEED_SECRET; fail closed here
  // too so tokens can never silently degrade to a publicly-computable derivation.
  if (!seed && process.env.NODE_ENV === "production") {
    throw new Error("SEED_SECRET is required to mint claim tokens");
  }
  return createHmac("sha256", `axon-mcp-claim:${seed}`).update(taskId).digest("hex").slice(0, 32);
}

function claimTokenValid(taskId: string, token: string): boolean {
  const expected = Buffer.from(claimTokenFor(taskId));
  const given = Buffer.from(String(token));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ── Tool definitions (MCP inputSchema = JSON Schema) ──────────────────────────

export const MCP_TOOLS = [
  {
    name: "search_agents",
    description:
      "Search the Axon agent marketplace. Returns agents with their id, capabilities, price (USDC per task; absent = free lane), reputation (0-10) and portable Proof Score (0-1000, third-party verifiable).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text description of the work you need" },
        capability: { type: "string", description: "Exact capability filter, e.g. 'research' or 'coding'" },
        limit: { type: "number", description: "Max results (default 5, max 20)" },
      },
    },
  },
  {
    name: "get_agent",
    description:
      "Full profile for one agent: capabilities, price, reputation, verification status, and its Proof Score with the evidence link so you can verify the track record independently.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string", description: "The agent id from search_agents" } },
      required: ["agentId"],
    },
  },
  {
    name: "hire_agent",
    description:
      "Hire an Axon agent for a task. Free-lane agents run immediately. Paid agents return payment requirements (USDC amount + Solana address): pay with your own wallet, then call again with paymentSignature — the payment IS the authorization, no account needed. Returns a taskId plus a claimToken; keep the claimToken, it is the only way to read the result.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The agent to hire (from search_agents)" },
        task: { type: "string", description: "The work to do" },
        context: { type: "object", description: "Optional structured hints for the agent" },
        paymentSignature: {
          type: "string",
          description: "Solana transaction signature of your USDC payment (required for paid agents, second call)",
        },
      },
      required: ["agentId", "task"],
    },
  },
  {
    name: "get_task_result",
    description:
      "Fetch a hired task's status and, once completed, its output. Requires the claimToken returned by hire_agent — task outputs are private to the hirer.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        claimToken: { type: "string", description: "The claim token from hire_agent" },
      },
      required: ["taskId", "claimToken"],
    },
  },
  {
    name: "get_receipt",
    description:
      "The public, verifiable proof for a task: parties, spec/output hashes, on-chain settlement, hash-chained execution trace, and the reproducibility verdict when the task has been re-run. Safe to share — never exposes task content.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
] as const;

// ── Tool implementations ──────────────────────────────────────────────────────

function agentSummary(a: Agent) {
  const pub = toPublicAgent(a) as Agent;
  return {
    agentId: pub.agentId,
    name: pub.name,
    capabilities: pub.capabilities,
    price: pub.price ?? null,
    reputation: pub.reputation,
    proofScore: pub.proofScore ?? null,
    verificationStatus: pub.verificationStatus ?? null,
  };
}

async function toolSearchAgents(args: Record<string, unknown>) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const capability = typeof args.capability === "string" ? args.capability.trim() : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);

  let agents: Agent[] | null = null;
  if (query) {
    agents = await semanticSearchAgents(query, { q: query, capability, limit });
  }
  if (!agents) {
    // Keyword fallback: capability filter first, then match query terms.
    const pool = searchAgents({ capability, sort: "reputation", limit: 200 });
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    agents =
      terms.length === 0
        ? pool
        : pool.filter((a) => {
            const hay = `${a.name} ${a.capabilities.join(" ")} ${a.category ?? ""}`.toLowerCase();
            return terms.some((t) => hay.includes(t));
          });
  }
  return { agents: agents.slice(0, limit).map(agentSummary) };
}

function toolGetAgent(args: Record<string, unknown>) {
  const agentId = String(args.agentId ?? "");
  const agent = getAgentById(agentId);
  if (!agent) return { error: `agent '${agentId}' not found` };
  const proof = computeProofScore(agentId);
  return {
    agent: agentSummary(agent),
    proofScore: proof
      ? { score: proof.score, tier: proof.tier, verify: `${BASE_URL}/api/agents/${agentId}/proof-score?verify=1` }
      : null,
    profileUrl: `${BASE_URL}/agents/${agentId}`,
  };
}

// Delegates to the real /api/tasks route handler so the MCP path inherits its
// free-lane limits, x402 payment verification, and replay guards verbatim. The
// caller's IP is forwarded so per-IP limits apply to the actual client.
async function toolHireAgent(args: Record<string, unknown>, clientIp: string) {
  const agentId = String(args.agentId ?? "");
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!agentId || !task) return { error: "agentId and task are required" };

  const agent = getAgentById(agentId);
  if (!agent) return { error: `agent '${agentId}' not found` };

  const paymentSignature = typeof args.paymentSignature === "string" ? args.paymentSignature.trim() : "";
  // Paid means exactly what the tasks route will enforce (parsePriceToSol) — a
  // price of "0 USDC" or unparseable text is free there, so it is free here too.
  const paid = parsePriceToSol(agent.price ?? undefined) !== null;
  if (paid && !paymentSignature) {
    const parsed = parsePaymentAmount(agent.price!);
    const payTo = process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ?? null;
    return {
      status: "payment_required",
      price: agent.price,
      amount: parsed?.amount ?? null,
      currency: parsed?.currency ?? null,
      payTo,
      network: "solana-mainnet",
      instructions: `Pay ${agent.price} to ${payTo ?? "the Axon treasury"} on Solana mainnet with your own wallet, then call hire_agent again with the transaction signature as paymentSignature. The payment is the authorization — no account needed.`,
    };
  }

  const { POST: createTaskRoute } = await import("@/app/api/tasks/route");
  const body: Record<string, unknown> = { from: "anonymous", to: agentId, task };
  if (args.context && typeof args.context === "object") body.context = args.context;
  if (paymentSignature) body.paymentSignature = paymentSignature;

  const req = new NextRequest(`${BASE_URL}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": clientIp },
    body: JSON.stringify(body),
  });
  const res = await createTaskRoute(req);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    return { error: String(json.error ?? `hire failed (${res.status})`), code: json.code ?? null };
  }

  const taskId = String(json.taskId);

  // A claim token is minted ONLY for a task this call newly created (201). A
  // payment-signature replay returns someone's EXISTING task (200 +
  // X-Payment-Replay) — Solana signatures are public on-chain, so minting a
  // token here would let anyone who watches the treasury read another hirer's
  // output. Refuse instead; the original hire already received its token.
  const isReplay = res.status !== 201 || res.headers.get("X-Payment-Replay") === "true";
  if (isReplay) {
    return {
      taskId,
      status: json.status,
      alreadyHired: true,
      receiptUrl: `${BASE_URL}/r/${taskId}`,
      note: "This payment signature was already used for an existing task. No claim token is issued on a replay — if this was your original hire, use the claimToken returned by that call. The public receipt remains viewable.",
    };
  }

  return {
    taskId,
    status: json.status,
    claimToken: claimTokenFor(taskId),
    receiptUrl: `${BASE_URL}/r/${taskId}`,
    note: "Keep the claimToken — it is the only way to read this task's output via get_task_result.",
  };
}

function toolGetTaskResult(args: Record<string, unknown>) {
  const taskId = String(args.taskId ?? "");
  const token = String(args.claimToken ?? "");
  if (!taskId || !token) return { error: "taskId and claimToken are required" };
  if (!claimTokenValid(taskId, token)) return { error: "invalid claim token for this task" };

  const task = getTaskById(taskId);
  if (!task) return { error: `task '${taskId}' not found` };
  // A failed TASK is a valid tool result, not a tool failure — report it as
  // `failureReason`, never `error` (the dispatcher flags isError by the presence
  // of an `error` key, so a completed result must not carry one).
  return {
    taskId,
    status: task.status,
    output: task.status === "completed" ? (task.output ?? null) : null,
    failureReason: task.status === "failed" ? (task.error ?? null) : null,
    receiptUrl: `${BASE_URL}/r/${taskId}`,
  };
}

function toolGetReceipt(args: Record<string, unknown>) {
  const taskId = String(args.taskId ?? "");
  const receipt = getPublicReceipt(taskId);
  if (!receipt) return { error: `no receipt for task '${taskId}'` };
  const trace = getPublicTrace(taskId);
  const repro = getReproProof(taskId);
  return {
    receipt,
    trace: trace ? { verified: trace.verified, events: trace.events.length, url: `${BASE_URL}/api/receipts/${taskId}/trace` } : null,
    reproducibility: repro
      ? { verdict: repro.verdict, similarity: repro.similarity, contentHash: repro.contentHash }
      : null,
    receiptUrl: `${BASE_URL}/r/${taskId}`,
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>, clientIp: string): Promise<unknown> {
  switch (name) {
    case "search_agents":
      return toolSearchAgents(args);
    case "get_agent":
      return toolGetAgent(args);
    case "hire_agent":
      return toolHireAgent(args, clientIp);
    case "get_task_result":
      return toolGetTaskResult(args);
    case "get_receipt":
      return toolGetReceipt(args);
    default:
      return null;
  }
}

// Handle one JSON-RPC message. Returns null for notifications (no id) — the
// route replies 202 with no body, per Streamable HTTP.
export async function handleMcpMessage(msg: JsonRpcRequest, clientIp: string): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize": {
      // Echo the client's requested protocol version when it sends one (our tool
      // surface is version-agnostic JSON-RPC), else advertise our own — per the
      // MCP handshake, so a newer-spec client doesn't reject an older reply.
      const requested = msg.params?.protocolVersion;
      const protocolVersion = typeof requested === "string" && requested ? requested : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "Axon is an open agent marketplace: search_agents to discover, hire_agent to create a task (paid agents return USDC payment requirements — pay with your own wallet, then retry with paymentSignature), get_task_result with your claimToken for the output, get_receipt for the public verifiable proof.",
      });
    }
    case "notifications/initialized":
    case "initialized":
      return null;
    case "ping":
      return isNotification ? null : rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const params = msg.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      let result: unknown;
      try {
        result = await callTool(name, args, clientIp);
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: e instanceof Error ? e.message : "tool execution failed" }],
          isError: true,
        });
      }
      if (result === null) return rpcError(id, -32602, `unknown tool '${name}'`);
      const isError = typeof result === "object" && result !== null && "error" in result;
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: Boolean(isError),
      });
    }
    default:
      return isNotification ? null : rpcError(id, -32601, `method '${msg.method}' not found`);
  }
}
