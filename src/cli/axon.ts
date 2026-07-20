#!/usr/bin/env node
// Axon CLI — search, hire, verify, login, register, send, receipt, cleanup.
//
// A thin command-line wrapper over the Axon REST API so you can drive the whole
// network from a terminal without writing code. Run via `npm run axon -- <cmd>`.
//
//   axon search  research                              # discover agents by capability
//   axon hire    research-agent "summarize the top 5 L2s"   # hire + wait + receipt
//   axon verify  <taskId>                              # recompute the receipt's proof locally
//   axon login   --api-key axon_sk_... [--endpoint https://axon-agents.com]
//   axon login   --keypair ./id.json                   # full wallet challenge/response
//   axon register --id my-agent --name "My Agent" --capabilities research,analysis \
//                 --wallet <SOLANA_ADDR> --public-key <ED25519_PUB> [--price "0.05 USDC"]
//   axon send    --from a --to research-agent --task "summarize x" [--payment "0.05 USDC"]
//   axon receipt <taskId>
//   axon cleanup                                       # revoke the stored key + clear config

import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";

const CONFIG_DIR = join(homedir(), ".axon");
export const DEFAULT_CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_ENDPOINT = "https://axon-agents.com";

export interface CliConfig {
  endpoint?: string;
  apiKey?: string;
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): CliConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: CliConfig, path = DEFAULT_CONFIG_PATH): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

export function clearConfig(path = DEFAULT_CONFIG_PATH): void {
  try {
    rmSync(path);
  } catch {
    /* nothing to clear */
  }
}

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

// Minimal argv parser: `cmd pos --flag value --bool`. `--flag` with no value (or
// followed by another --flag) is a boolean true.
export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

// Map register flags to the POST /api/agents body. Throws on missing required fields.
export function buildRegisterBody(flags: Record<string, string | boolean>): Record<string, unknown> {
  const id = str(flags, "id");
  const name = str(flags, "name");
  const capabilities = str(flags, "capabilities");
  const wallet = str(flags, "wallet");
  const publicKey = str(flags, "public-key");
  const missing = [
    ["--id", id],
    ["--name", name],
    ["--capabilities", capabilities],
    ["--wallet", wallet],
    ["--public-key", publicKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`register is missing required flags: ${missing.join(", ")}`);

  const body: Record<string, unknown> = {
    agentId: id,
    name,
    capabilities: capabilities!.split(",").map((c) => c.trim()).filter(Boolean),
    walletAddress: wallet,
    publicKey,
    provider: str(flags, "provider") ?? "anthropic",
  };
  const price = str(flags, "price");
  const category = str(flags, "category");
  const endpoint = str(flags, "agent-endpoint");
  if (price) body.price = price;
  if (category) body.category = category;
  if (endpoint) body.endpoint = endpoint;
  return body;
}

// Map send flags to the POST /api/tasks body.
export function buildTaskBody(flags: Record<string, string | boolean>): Record<string, unknown> {
  const from = str(flags, "from");
  const to = str(flags, "to");
  const task = str(flags, "task");
  const missing = [
    ["--from", from],
    ["--to", to],
    ["--task", task],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`send is missing required flags: ${missing.join(", ")}`);

  // Note: idempotency is sent as the `Idempotency-Key` HEADER by the send command,
  // not in the body (the API reads it from the header).
  const body: Record<string, unknown> = { from, to, task };
  const payment = str(flags, "payment");
  const context = str(flags, "context");
  if (payment) body.payment = payment;
  if (context) {
    try {
      body.context = JSON.parse(context);
    } catch {
      throw new Error("--context must be valid JSON");
    }
  }
  return body;
}

function endpointOf(flags: Record<string, string | boolean>, cfg: CliConfig): string {
  return str(flags, "endpoint") ?? cfg.endpoint ?? DEFAULT_ENDPOINT;
}

async function api(
  endpoint: string,
  method: string,
  path: string,
  apiKey?: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(`${endpoint}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    const detail = typeof json === "string" ? json : JSON.stringify(json);
    throw new Error(`${method} ${path} -> ${res.status}: ${detail}`);
  }
  return json;
}

const HELP = `Axon CLI

Usage: axon <command> [flags]

Commands:
  search    Find agents for a capability, ranked by Proof Score:
              axon search <capability> [--limit N]
  hire      Hire an agent, wait for the result, and print its receipt:
              axon hire <agentId> "<task>"
            Paid agents: pay the USDC, then re-run with
              --payment-signature <sig> --payer-wallet <addr>
  verify    Recompute a receipt's proof locally (no trust in Axon required):
              axon verify <taskId>
  login     Authenticate. --api-key <key> to store a key, or --keypair <file>
            for the full wallet challenge/response. --endpoint <url> optional.
  register  Register an agent. Required: --id --name --capabilities (comma list)
            --wallet --public-key. Optional: --provider --price --category --agent-endpoint.
  send      Send a task. Required: --from --to --task. Optional: --payment
            --idempotency-key --context (JSON).
  receipt   Inspect a task receipt:  axon receipt <taskId>
  cleanup   Revoke the stored API key and clear local config.
  help      Show this message.

Config is stored at ~/.axon/config.json.`;

async function cmdLogin(flags: Record<string, string | boolean>): Promise<string> {
  const cfg = loadConfig();
  const endpoint = endpointOf(flags, cfg);

  const directKey = str(flags, "api-key");
  if (directKey) {
    saveConfig({ endpoint, apiKey: directKey });
    return `Saved API key for ${endpoint}`;
  }

  const keypairPath = str(flags, "keypair");
  if (keypairPath) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")) as number[]);
    const keypair = Keypair.fromSecretKey(secret);
    const wallet = keypair.publicKey.toBase58();
    const { challenge } = (await api(endpoint, "POST", "/api/auth/challenge", undefined, {
      walletAddress: wallet,
    })) as { challenge: string };
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(challenge), keypair.secretKey),
    ).toString("base64");
    const result = (await api(endpoint, "POST", "/api/auth/login", undefined, {
      walletAddress: wallet,
      challenge,
      signature,
    })) as { apiKey: string };
    saveConfig({ endpoint, apiKey: result.apiKey });
    return `Logged in as ${wallet} on ${endpoint}`;
  }

  throw new Error("login needs --api-key <key> or --keypair <file>");
}

// ── Trustless receipt verification (recompute the hash chain locally) ─────────
// Byte-identical to the server (traceEvents.ts): canonical JSON (recursive
// key-sort) + SHA-256. In JS, JSON.stringify already matches the server's number
// formatting, so this recompute is exact. Detects any edit/reorder/insertion/
// interior deletion.
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

interface TraceEvent {
  seq: number; taskId: string | null; kind: string; fromAgent: string | null; toAgent: string | null;
  workflowId: string | null; stepIndex: number | null; inputHash: string | null; outputHash: string | null;
  model: string | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null;
  latencyMs: number | null; meta: Record<string, unknown> | null; prevHash: string | null; hash: string; createdAt: string;
}

export function verifyTrace(trace: { traceId: string; verified?: boolean; events: TraceEvent[] }): {
  chainValid: boolean; brokenAt: number | null; eventCount: number; platformClaim?: boolean;
} {
  let prevHash: string | null = null;
  let expectedSeq = 1;
  let brokenAt: number | null = null;
  for (const e of trace.events) {
    const metaStr = e.meta == null ? null : canonicalStringify(e.meta);
    const recomputed = createHash("sha256").update(canonicalStringify({
      traceId: trace.traceId, seq: e.seq, taskId: e.taskId, kind: e.kind, fromAgent: e.fromAgent,
      toAgent: e.toAgent, workflowId: e.workflowId, stepIndex: e.stepIndex, inputHash: e.inputHash,
      outputHash: e.outputHash, model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens,
      costUsd: e.costUsd, latencyMs: e.latencyMs, meta: metaStr, createdAt: e.createdAt, prevHash: e.prevHash,
    }), "utf8").digest("hex");
    if (e.seq !== expectedSeq || e.prevHash !== prevHash || e.hash !== recomputed) { brokenAt = e.seq; break; }
    prevHash = e.hash;
    expectedSeq += 1;
  }
  return {
    chainValid: brokenAt === null && trace.events.length > 0,
    brokenAt,
    eventCount: trace.events.length,
    platformClaim: typeof trace.verified === "boolean" ? trace.verified : undefined,
  };
}

// ── Commands: search, hire, verify ───────────────────────────────────────────
async function cmdSearch(endpoint: string, positional: string[], flags: Record<string, string | boolean>): Promise<string> {
  const capability = positional[0] ?? str(flags, "capability");
  if (!capability) throw new Error('usage: axon search <capability> [--limit N]');
  const limit = str(flags, "limit") ?? "10";
  const qs = new URLSearchParams({ capability, sort: "proven", limit }).toString();
  const { agents } = (await api(endpoint, "GET", `/api/agents?${qs}`)) as { agents: { agentId: string; name: string; price?: string | null; proofScore?: number | null }[] };
  if (!agents?.length) return `No agents found for "${capability}".`;
  const rows = agents.map((a) => {
    const price = (a.price || "free").padEnd(10);
    const proof = a.proofScore != null ? `proof ${a.proofScore}` : "";
    return `  ${a.agentId.padEnd(20)} ${price} ${proof.padEnd(11)} ${a.name}`;
  });
  return `Agents for "${capability}" (ranked by Proof Score):\n${rows.join("\n")}`;
}

async function cmdHire(endpoint: string, positional: string[], flags: Record<string, string | boolean>): Promise<string> {
  const to = positional[0] ?? str(flags, "to");
  const task = positional[1] ?? str(flags, "task");
  if (!to || !task) throw new Error('usage: axon hire <agentId> "<task>" [--payment-signature <sig> --payer-wallet <addr>]');

  // Probe x402 to see if the agent is priced.
  let terms: { accepts?: { maxAmountRequired?: string; payToAddress?: string }[] } | null = null;
  const probe = await fetch(`${endpoint}/api/agents/${encodeURIComponent(to)}/x402`);
  if (probe.status === 402) {
    const raw = probe.headers.get("x-payment-required");
    if (raw) { try { terms = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); } catch { /* ignore */ } }
  }
  const sig = str(flags, "payment-signature");
  const payer = str(flags, "payer-wallet");
  if (terms && !sig) {
    const opt = terms.accepts?.[0];
    const amt = opt?.maxAmountRequired ? Number(opt.maxAmountRequired) / 1_000_000 : "?";
    return `"${to}" is a paid agent (${amt} USDC). Pay ${amt} USDC to ${opt?.payToAddress} on Solana, then re-run with --payment-signature <sig> --payer-wallet <addr>.`;
  }

  const body: Record<string, unknown> = { from: "anonymous", to, task };
  if (sig) body.paymentSignature = sig;
  if (payer) body.payerWallet = payer;
  const created = (await api(endpoint, "POST", "/api/tasks", undefined, body)) as { taskId: string; claimToken?: string; status?: string };
  const { taskId, claimToken } = created;

  process.stderr.write(`Hired ${to} — task ${taskId}, running…\n`);
  const deadline = Date.now() + 90_000;
  let status = created.status ?? "queued";
  let output = "";
  while (status !== "completed" && status !== "failed") {
    if (Date.now() > deadline) throw new Error(`Task ${taskId} still ${status} after 90s — no result delivered. Check the receipt: ${endpoint}/r/${taskId}`);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const t = (await api(endpoint, "GET", `/api/tasks/${encodeURIComponent(taskId)}`, undefined, undefined, claimToken ? { "x-claim-token": claimToken } : undefined)) as { status?: string; output?: string };
      status = t.status ?? status;
      output = t.output ?? output;
    } catch { /* transient — keep polling */ }
  }
  if (status === "failed") throw new Error(`Task ${taskId} failed. Receipt: ${endpoint}/r/${taskId}`);
  return `${output}\n\nReceipt: ${endpoint}/r/${taskId}\nVerify it yourself: axon verify ${taskId}`;
}

async function cmdVerify(endpoint: string, positional: string[]): Promise<string> {
  const taskId = positional[0];
  if (!taskId) throw new Error("usage: axon verify <taskId>");
  // `verify` is a gate: it returns (exit 0) ONLY when the chain is confirmed
  // intact. Every other outcome — tampered, no trace, a mistyped id — throws, so
  // the CLI exits non-zero and prints to stderr and `axon verify $id && …`
  // composes correctly in CI (a tampered or missing receipt must never pass).
  // The trace endpoint is public (no auth), so fetch it directly (api() would
  // bury the 404's friendly message under a raw HTTP error).
  const res = await fetch(`${endpoint}/api/receipts/${encodeURIComponent(taskId)}/trace`);
  if (res.status === 404) throw new Error(`No execution trace found for task ${taskId}.`);
  if (!res.ok) throw new Error(`GET /api/receipts/${taskId}/trace -> ${res.status}: ${await res.text()}`);
  const trace = (await res.json()) as { traceId: string; verified?: boolean; events: TraceEvent[] } | null;
  if (!trace?.events) throw new Error(`No execution trace found for task ${taskId}.`);
  const r = verifyTrace(trace);
  if (r.eventCount === 0) throw new Error("Trace has no events to verify.");
  if (!r.chainValid) throw new Error(`TAMPERED: the hash chain breaks at event #${r.brokenAt} — the recomputed hash or link does not match.`);
  return `Verified: recomputed all ${r.eventCount} event${r.eventCount !== 1 ? "s" : ""} locally — the hash chain is intact.\nReceipt: ${endpoint}/r/${taskId}`;
}

async function run(parsed: ParsedArgs): Promise<string> {
  const { command, positional, flags } = parsed;
  const cfg = loadConfig();
  const endpoint = endpointOf(flags, cfg);

  switch (command) {
    case "login":
      return cmdLogin(flags);
    case "search":
      return cmdSearch(endpoint, positional, flags);
    case "hire":
      return cmdHire(endpoint, positional, flags);
    case "verify":
      return cmdVerify(endpoint, positional);
    case "register": {
      const agent = (await api(endpoint, "POST", "/api/agents", cfg.apiKey, buildRegisterBody(flags))) as {
        agentId?: string;
      };
      return `Registered agent: ${agent.agentId ?? JSON.stringify(agent)}`;
    }
    case "send": {
      const idem = str(flags, "idempotency-key");
      const task = (await api(
        endpoint,
        "POST",
        "/api/tasks",
        cfg.apiKey,
        buildTaskBody(flags),
        idem ? { "Idempotency-Key": idem } : undefined,
      )) as { taskId?: string; status?: string };
      return `Task ${task.taskId ?? "?"} -> ${task.status ?? "?"}`;
    }
    case "receipt": {
      const id = positional[0];
      if (!id) throw new Error("usage: axon receipt <taskId>");
      const receipt = await api(endpoint, "GET", `/api/receipts/${encodeURIComponent(id)}`, cfg.apiKey);
      return JSON.stringify(receipt, null, 2);
    }
    case "cleanup": {
      if (cfg.apiKey) {
        await api(endpoint, "DELETE", "/api/auth/logout", cfg.apiKey).catch(() => undefined);
      }
      clearConfig();
      return "Revoked API key and cleared local config.";
    }
    case "help":
    default:
      return HELP;
  }
}

async function main(): Promise<void> {
  try {
    const out = await run(parseArgs(process.argv.slice(2)));
    console.log(out);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Only execute when run directly (not when imported by tests).
const entry = process.argv[1] ?? "";
if (entry.endsWith("axon.ts") || entry.endsWith("axon.js") || entry.endsWith(`${join("cli", "axon")}`)) {
  void main();
}
