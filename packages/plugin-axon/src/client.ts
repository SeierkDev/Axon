// A tiny, dependency-free client for the Axon MCP server. Axon exposes its
// marketplace over MCP (Streamable HTTP, JSON-RPC 2.0) at POST <baseUrl>/mcp,
// so an agent can search → hire → read the result → pull the verifiable receipt
// with nothing but fetch. This client wraps those four tools with typed helpers.
//
// The flow it encodes (identical to what any MCP client sees):
//   1. searchAgents(query)                 → discover capable agents + Proof Score
//   2. hireAgent({ agentId, task })        → free-lane runs now; paid → payment_required
//   3. (paid) pay USDC with your wallet, hireAgent again with paymentSignature
//   4. getTaskResult({ taskId, claimToken })→ the output (private to the hirer)
//   5. getReceipt({ taskId })              → public, shareable, on-chain-verifiable proof

export interface AxonAgent {
  agentId: string;
  name: string;
  capabilities: string[];
  price?: string | null; // e.g. "0.5 USDC"; absent/free = free lane
  reputation?: number; // 0-10
  proofScore?: number; // 0-1000, third-party verifiable
}

export interface HireFree {
  taskId: string;
  status: string;
  claimToken: string; // KEEP THIS — the only way to read the output
  receiptUrl: string;
}
export interface HirePaymentRequired {
  status: "payment_required";
  price: string | null;
  amount: number | null;
  currency: string | null;
  payTo: string | null;
  network: string; // "solana-mainnet"
  instructions: string;
}
export interface HireReplay {
  taskId: string;
  status: string;
  alreadyHired: true;
  receiptUrl: string;
  note: string;
}
export type HireResult = HireFree | HirePaymentRequired | HireReplay;

export interface TaskResult {
  taskId: string;
  status: string; // "queued" | "running" | "completed" | "failed" | ...
  output?: unknown;
  [k: string]: unknown;
}

export function isPaymentRequired(r: HireResult): r is HirePaymentRequired {
  return (r as HirePaymentRequired).status === "payment_required";
}
export function isHired(r: HireResult): r is HireFree {
  return typeof (r as HireFree).claimToken === "string";
}

export class AxonError extends Error {}

let rpcId = 0;

export class AxonClient {
  private readonly endpoint: string;

  constructor(baseUrl = "https://axon-agents.com") {
    this.endpoint = `${baseUrl.replace(/\/+$/, "")}/mcp`;
  }

  // One JSON-RPC tools/call round-trip. Axon returns the tool result as a JSON
  // string inside an MCP content block; we parse it back out and surface tool
  // errors (isError) as thrown AxonErrors.
  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    if (!res.ok) throw new AxonError(`Axon MCP HTTP ${res.status}`);
    const env = (await res.json()) as {
      error?: { message?: string };
      result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    };
    if (env.error) throw new AxonError(env.error.message ?? "Axon MCP error");
    const text = env.result?.content?.find((c) => c.type === "text")?.text ?? "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AxonError("Axon returned an unparseable tool result");
    }
    if (env.result?.isError) {
      const msg = (parsed as { error?: string })?.error ?? "Axon tool error";
      throw new AxonError(msg);
    }
    return parsed as T;
  }

  searchAgents(args: { query?: string; capability?: string; limit?: number }): Promise<{ agents: AxonAgent[] }> {
    return this.call("search_agents", args);
  }

  getAgent(agentId: string): Promise<AxonAgent> {
    return this.call("get_agent", { agentId });
  }

  hireAgent(args: { agentId: string; task: string; context?: Record<string, unknown>; paymentSignature?: string }): Promise<HireResult> {
    return this.call("hire_agent", args);
  }

  getTaskResult(args: { taskId: string; claimToken: string }): Promise<TaskResult> {
    return this.call("get_task_result", args);
  }

  getReceipt(taskId: string): Promise<Record<string, unknown>> {
    return this.call("get_receipt", { taskId });
  }

  // Convenience: poll get_task_result until the task leaves a running/queued
  // state (or the attempt budget runs out). Returns the final TaskResult.
  async waitForResult(
    args: { taskId: string; claimToken: string },
    opts: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<TaskResult> {
    const attempts = opts.attempts ?? 30;
    const intervalMs = opts.intervalMs ?? 2000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // Axon task lifecycle: payment_pending → queued → running → completed|failed.
    // Poll until a TERMINAL state (or the budget runs out); any non-terminal or
    // unknown status keeps waiting, so a new status never ends the poll early.
    let last: TaskResult = { taskId: args.taskId, status: "unknown" };
    for (let i = 0; i < attempts; i++) {
      last = await this.getTaskResult(args);
      if (last.status === "completed" || last.status === "failed") return last;
      await sleep(intervalMs);
    }
    return last;
  }
}
