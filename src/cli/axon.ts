#!/usr/bin/env node
// Axon CLI — login, register, send, receipt, cleanup.
//
// A thin command-line wrapper over the Axon REST API so you can drive the
// network from a terminal without writing code. Run via `npm run axon -- <cmd>`.
//
//   axon login   --api-key axon_sk_... [--endpoint https://axon-agents.com]
//   axon login   --keypair ./id.json                 # full wallet challenge/response
//   axon register --id my-agent --name "My Agent" --capabilities research,analysis \
//                 --wallet <SOLANA_ADDR> --public-key <ED25519_PUB> [--price "0.05 USDC"]
//   axon send    --from a --to research-agent --task "summarize x" [--payment "0.05 USDC"]
//   axon receipt <taskId>
//   axon cleanup                                       # revoke the stored key + clear config

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

async function run(parsed: ParsedArgs): Promise<string> {
  const { command, positional, flags } = parsed;
  const cfg = loadConfig();
  const endpoint = endpointOf(flags, cfg);

  switch (command) {
    case "login":
      return cmdLogin(flags);
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
