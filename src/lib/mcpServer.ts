// Axon as an MCP server — the network as a toolbox for any MCP client.
//
// One endpoint (POST /mcp) speaking MCP over Streamable HTTP (JSON-RPC 2.0,
// plain JSON responses — the same wire shape our own McpHttpClient consumes, so
// Axon speaks MCP in both directions). Any MCP client — a terminal coding agent,
// Claude Code, Cursor — adds the URL and gets the full hire loop as tools:
//
//   search_agents -> hire_agent -> get_task_result -> get_receipt
//
// Payments stay non-custodial, exactly like the rest of Axon. Two ways to pay for a paid hire:
//
//   with an allowance key on the connection (Authorization header in the client's MCP config):
//     hire_agent pays from the owner's on-chain allowance, inside the owner's rules and the key's
//     own limits. Nobody leaves the chat. See allowancePayment.ts.
//   without one: hire_agent returns x402-style payment requirements (amount + treasury address);
//     the client pays with its own wallet and calls hire_agent again with the payment signature.
//
// This module never touches funds either way: hire_agent delegates to the real /api/tasks route
// handler, inheriting its free-lane limits, payment verification, allowance checks and replay guards
// without duplicating any of it.
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
import { parsePriceToEth } from "./payments";
import { parsePaymentAmount } from "./money";
import { authenticateApiKey } from "./identity";
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

export function claimTokenValid(taskId: string, token: string): boolean {
  const expected = Buffer.from(claimTokenFor(taskId));
  const given = Buffer.from(String(token));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ── Tool definitions (MCP inputSchema = JSON Schema) ──────────────────────────

export const MCP_TOOLS = [
  {
    name: "search_agents",
    description:
      "Search the Axon agent marketplace. Returns agents with their id, capabilities, price (ETH per task; absent = free lane), reputation (0-10) and portable Proof Score (0-1000, third-party verifiable).",
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
      "Hire an Axon agent for a task. Free-lane agents run immediately. Paid agents: if this connection carries an Axon allowance key, the hire is paid automatically from the owner's on-chain allowance, within their limits; if a limit would be exceeded the reason comes back in words. Without a key, paid agents return payment requirements (an ETH amount and an address): pay with your own wallet, then call again with paymentSignature. Returns a taskId plus a claimToken; keep the claimToken, it is the only way to read the result.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The agent to hire (from search_agents)" },
        task: { type: "string", description: "The work to do" },
        context: { type: "object", description: "Optional structured hints for the agent" },
        paymentSignature: {
          type: "string",
          description: "Transaction hash of your ETH payment (required for paid agents, second call)",
        },
        payerWallet: {
          type: "string",
          description: "The address that sent the payment (send with paymentSignature for paid agents)",
        },
        payIn: {
          type: "string",
          enum: ["ETH", "AXON"],
          description: "With an allowance key: pay in ETH (default) or in $AXON, for agents that accept it",
        },
        idempotencyKey: {
          type: "string",
          description: "A unique string for this hire, 8-128 characters of letters, numbers, '.', '_', ':' or '-'. Retrying with the same key returns the same task instead of paying twice",
        },
      },
      required: ["agentId", "task"],
    },
  },
  {
    name: "get_task_result",
    description:
      "Fetch a hired task's status and, once completed, its output. Requires the claimToken returned by hire_agent, task outputs are private to the hirer.",
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
    name: "get_allowance",
    description:
      "What the allowance behind this connection's key can still spend: available balance, per-task and daily limits and what is left today, for ETH and $AXON, plus this key's own limits. Needs an Axon allowance key in the connection's Authorization header.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_receipt",
    description:
      "The public, verifiable proof for a task: parties, spec/output hashes, on-chain settlement, hash-chained execution trace, and the reproducibility verdict when the task has been re-run. Safe to share, never exposes task content.",
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
    // Whether this agent can go and look things up. A caller choosing between
    // agents needs this: it's the difference between an answer from training
    // data and one grounded in live sources.
    tools: pub.tools?.length ? pub.tools : null,
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
async function toolHireAgent(args: Record<string, unknown>, clientIp: string, apiKey: string | null) {
  const agentId = String(args.agentId ?? "");
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!agentId || !task) return { error: "agentId and task are required" };

  const agent = getAgentById(agentId);
  if (!agent) return { error: `agent '${agentId}' not found` };

  const paymentSignature = typeof args.paymentSignature === "string" ? args.paymentSignature.trim() : "";
  const payerWallet = typeof args.payerWallet === "string" ? args.payerWallet.trim() : "";
  // Paid means exactly what the tasks route will enforce (parsePriceToEth) — a
  // price of "0 ETH" or unparseable text is free there, so it is free here too.
  const paid = parsePriceToEth(agent.price ?? undefined) !== null;
  if (paid && !paymentSignature && apiKey) {
    return hireFromAllowance(args, agent, task, clientIp, apiKey);
  }
  if (paid && !paymentSignature) {
    const parsed = parsePaymentAmount(agent.price!);
    const payTo = process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ?? null;
    return {
      status: "payment_required",
      price: agent.price,
      amount: parsed?.amount ?? null,
      currency: parsed?.currency ?? null,
      payTo,
      network: "eip155:4663",
      instructions: `Pay ${agent.price} to ${payTo ?? "the Axon treasury"} on Robinhood Chain with your own wallet, then call hire_agent again with the transaction hash as paymentSignature and your wallet address as payerWallet. The payment is the authorization, no account needed.`,
      orUseAnAllowance: "Or add an Axon allowance key to this MCP connection's Authorization header, and hire_agent pays from your on-chain allowance automatically, within your limits.",
    };
  }

  const { POST: createTaskRoute } = await import("@/app/api/tasks/route");
  const body: Record<string, unknown> = { from: "anonymous", to: agentId, task };
  if (args.context && typeof args.context === "object") body.context = args.context;
  if (paymentSignature) body.paymentSignature = paymentSignature;
  if (payerWallet) body.payerWallet = payerWallet;

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
      note: "This payment signature was already used for an existing task. No claim token is issued on a replay, if this was your original hire, use the claimToken returned by that call. The public receipt remains viewable.",
    };
  }

  return {
    taskId,
    status: json.status,
    claimToken: claimTokenFor(taskId),
    receiptUrl: `${BASE_URL}/r/${taskId}`,
    note: "Keep the claimToken, it is the only way to read this task's output via get_task_result.",
  };
}

/** The wallet a key on this connection belongs to, or null if it is not a key we know. */
function walletForKey(apiKey: string): string | null {
  const probe = new NextRequest(`${BASE_URL}/mcp`, { headers: { "x-api-key": apiKey } });
  return authenticateApiKey(probe, { allowAllowanceScope: true })?.walletAddress ?? null;
}

/** An error the tasks route returned, as the words it said. */
function routeError(json: Record<string, unknown>, status: number) {
  return { error: typeof json.error === "string" ? json.error : `hire failed (${status})`, code: json.code ?? null };
}

// A paid hire, paid from the allowance of the wallet this connection's key belongs to. The tasks route
// does every check: the owner's rules on chain, the key's own limits, and refusal in words.
async function hireFromAllowance(
  args: Record<string, unknown>,
  agent: Agent,
  task: string,
  clientIp: string,
  apiKey: string,
) {
  const wallet = walletForKey(apiKey);
  if (!wallet) return { error: "The Authorization key on this MCP connection is not a valid Axon key" };

  const body: Record<string, unknown> = { from: wallet, to: agent.agentId, task, paymentMethod: "allowance" };
  if (args.context && typeof args.context === "object") body.context = args.context;

  // The route makes a quote for this hire alone; see freshAxonQuoteFor.
  if (args.payIn === "AXON") body.payIn = "AXON";

  const { POST: createTaskRoute } = await import("@/app/api/tasks/route");
  const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey.trim() : "";
  const res = await createTaskRoute(new NextRequest(`${BASE_URL}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": clientIp,
      "x-api-key": apiKey,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  }));
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) return routeError(json, res.status);

  const taskId = String(json.taskId);
  return {
    taskId,
    status: json.status,
    paidFrom: "allowance",
    ...(res.headers.get("X-Idempotent-Replay") === "true" ? { alreadyHired: true } : {}),
    claimToken: claimTokenFor(taskId),
    receiptUrl: `${BASE_URL}/r/${taskId}`,
    note: "Paid from your allowance. Keep the claimToken, it is the only way to read this task's output via get_task_result.",
  };
}

async function toolGetAllowance(apiKey: string | null) {
  if (!apiKey) {
    return { error: "get_allowance needs an Axon allowance key in this MCP connection's Authorization header" };
  }
  const { GET: allowanceRoute } = await import("@/app/api/allowance/route");
  const res = await allowanceRoute(new NextRequest(`${BASE_URL}/api/allowance`, { headers: { "x-api-key": apiKey } }));
  const json = (await res.json()) as Record<string, unknown>;
  return res.ok ? json : routeError(json, res.status);
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

async function callTool(name: string, args: Record<string, unknown>, clientIp: string, apiKey: string | null): Promise<unknown> {
  switch (name) {
    case "search_agents":
      return toolSearchAgents(args);
    case "get_agent":
      return toolGetAgent(args);
    case "hire_agent":
      return toolHireAgent(args, clientIp, apiKey);
    case "get_allowance":
      return toolGetAllowance(apiKey);
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
/**
 * @param apiKey the key on the connection's Authorization header, if any. Optional: discovery, free
 *   hires and receipts need none. With one, paid hires pay from the owner's allowance.
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  clientIp: string,
  apiKey: string | null = null,
): Promise<JsonRpcResponse | null> {
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
          "Axon is an open agent marketplace: search_agents to discover, hire_agent to create a task, get_task_result with your claimToken for the output, get_receipt for the public verifiable proof. Paid agents: with an Axon allowance key on this connection, hire_agent pays from the owner's on-chain allowance automatically (get_allowance shows what is left); without one, it returns ETH payment requirements to pay with your own wallet and retry with paymentSignature.",
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
        result = await callTool(name, args, clientIp, apiKey);
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
