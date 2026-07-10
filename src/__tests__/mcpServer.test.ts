// Axon as an MCP server. Contracts — (1) speaks the same JSON-RPC wire shape our
// own McpHttpClient sends; (2) the full loop works: search -> hire -> result ->
// receipt; (3) paid hires return payment requirements instead of running; (4)
// task outputs are readable ONLY with the claim token issued at hire time.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as mcpPOST, GET as mcpGET } from "@/app/mcp/route";
import { claimTokenFor } from "@/lib/mcpServer";
import { createAgent } from "@/lib/agents";
import { createTask, startTask, completeTask } from "@/lib/tasks";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

let n = 0;
function makeAgent(overrides: Partial<Agent> = {}): Agent {
  n++;
  const a: Agent = {
    agentId: `mcp-srv-agent-${n}`,
    name: `Mcp Srv Agent ${n}`,
    capabilities: ["research", "analysis"],
    publicKey: `pk-mcp-srv-${n}`,
    provider: "anthropic",
    reputation: 0,
    category: "Research",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  createAgent(a);
  return a;
}

// Sends exactly what McpHttpClient.rpc sends.
async function rpc(method: string, params: Record<string, unknown> = {}, id: number | undefined = 1) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;
  const req = new NextRequest("https://axon-agents.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return mcpPOST(req);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await rpc("tools/call", { name, arguments: args });
  const json = (await res.json()) as { result: { content: { type: string; text: string }[]; isError: boolean } };
  const text = json.result.content[0]?.text ?? "{}";
  return { data: JSON.parse(text) as Record<string, unknown>, isError: json.result.isError };
}

function makeFailedTask(agentId: string, reason = "worker crashed"): string {
  const t = createTask({ fromAgent: "anonymous", toAgent: agentId, task: "will fail" });
  startTask(t.taskId);
  // failTask sets status + error the same way the worker does.
  getDb().prepare("UPDATE tasks SET status = 'failed', error = ? WHERE task_id = ?").run(reason, t.taskId);
  return t.taskId;
}

describe("MCP endpoint: protocol surface", () => {
  it("initialize returns protocol version, server info, and tool capability", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const json = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(json.result.protocolVersion).toBe("2025-03-26");
    expect(json.result.serverInfo.name).toBe("axon");
  });

  it("initialize echoes the client's requested protocol version, else its own", async () => {
    const newer = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    expect(((await newer.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    const none = await rpc("initialize", { capabilities: {} });
    expect(((await none.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-03-26");
  });

  it("tools/list exposes the five marketplace tools", async () => {
    const res = await rpc("tools/list");
    const json = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = json.result.tools.map((t) => t.name);
    expect(names).toEqual(["search_agents", "get_agent", "hire_agent", "get_task_result", "get_receipt"]);
  });

  it("notifications get 202 with no body", async () => {
    const res = await rpc("notifications/initialized", {}, undefined);
    expect(res.status).toBe(202);
  });

  it("a null or primitive JSON body is rejected cleanly, not crashed on", async () => {
    for (const body of ["null", '"hello"', "42"]) {
      const res = await mcpPOST(
        new NextRequest("https://axon-agents.com/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: number } };
      expect(json.error.code).toBe(-32600);
    }
  });

  it("unknown methods and unknown tools error cleanly", async () => {
    const res = await rpc("resources/list");
    const json = (await res.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32601);

    const badRes = await rpc("tools/call", { name: "not_a_tool", arguments: {} });
    const bad = (await badRes.json()) as { error: { code: number } };
    expect(bad.error.code).toBe(-32602);
  });

  it("GET describes the endpoint", async () => {
    const res = await mcpGET();
    const json = (await res.json()) as { protocol: string; tools: string[] };
    expect(json.protocol).toBe("mcp");
    expect(json.tools).toContain("hire_agent");
  });
});

describe("MCP tools: the full hire loop", () => {
  it("search_agents finds agents by keyword", async () => {
    const agent = makeAgent({ name: "Zylophite Specialist" }); // unique term — ranking is reputation-based
    const { data } = await callTool("search_agents", { query: "zylophite" });
    const agents = data.agents as { agentId: string }[];
    expect(agents.some((a) => a.agentId === agent.agentId)).toBe(true);
  });

  it("get_agent returns profile + proof score block", async () => {
    const agent = makeAgent();
    const { data } = await callTool("get_agent", { agentId: agent.agentId });
    expect((data.agent as { agentId: string }).agentId).toBe(agent.agentId);
    expect(data.profileUrl).toContain(agent.agentId);
  });

  it("hire_agent on a free agent creates a task and returns a claim token", async () => {
    const agent = makeAgent(); // no price = free lane
    const { data, isError } = await callTool("hire_agent", { agentId: agent.agentId, task: "summarize x" });
    expect(isError).toBe(false);
    expect(data.taskId).toBeTruthy();
    expect(data.claimToken).toBe(claimTokenFor(String(data.taskId)));
  });

  it("hire_agent on a paid agent returns payment requirements, creates nothing", async () => {
    const agent = makeAgent({ price: "0.25 USDC" });
    const { data } = await callTool("hire_agent", { agentId: agent.agentId, task: "paid work" });
    expect(data.status).toBe("payment_required");
    expect(data.price).toBe("0.25 USDC");
    expect(data.currency).toBe("USDC");
    expect(String(data.instructions)).toContain("paymentSignature");
  });

  it("payment requirements state the agent's real currency, not hardcoded USDC", async () => {
    const agent = makeAgent({ price: "0.05 SOL" });
    const { data } = await callTool("hire_agent", { agentId: agent.agentId, task: "sol work" });
    expect(data.status).toBe("payment_required");
    expect(data.currency).toBe("SOL");
    expect(data.amount).toBe(0.05);
  });

  it("the free-demo quota never blocks a PAYING anonymous hire", async () => {
    // The 3-free-calls limiter is skipped under VITEST — unset it so the real
    // gate runs, and confirm it only applies to the actual free lane.
    const savedVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const paidAgent = makeAgent({ price: "0.25 USDC" });
      // 4 paid attempts with a (bogus) signature: the quota must never fire —
      // each fails at PAYMENT verification, proving it got past the limiter.
      for (let i = 0; i < 4; i++) {
        const { data } = await callTool("hire_agent", {
          agentId: paidAgent.agentId,
          task: `paid attempt ${i}`,
          paymentSignature: `BogusSig${i}1111111111111111111111111111111111111111111111`,
        });
        expect(data.code).not.toBe("FREE_LIMIT_REACHED");
      }

      // The actual free lane still enforces 3 per agent per IP.
      const freeAgent = makeAgent();
      let limited = false;
      for (let i = 0; i < 4; i++) {
        const { data } = await callTool("hire_agent", { agentId: freeAgent.agentId, task: `free ${i}` });
        if (data.code === "FREE_LIMIT_REACHED") limited = true;
      }
      expect(limited).toBe(true);
    } finally {
      if (savedVitest !== undefined) process.env.VITEST = savedVitest;
    }
  });

  it("a payment-signature replay never mints a claim token for someone else's task", async () => {
    // The victim's paid task + its settled incoming payment (signature is public on-chain).
    const agent = makeAgent({ price: "0.25 USDC" });
    const victim = createTask({ fromAgent: "anonymous", toAgent: agent.agentId, task: "victim's private job" });
    startTask(victim.taskId);
    completeTask(victim.taskId, "VICTIM-PRIVATE-OUTPUT");
    const sig = "ReplayedOnChainSignature1111111111111111111111111111111111111111";
    getDb()
      .prepare(
        `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at)
         VALUES ('tx-replay-1', ?, 'anonymous', ?, 0.25, 'completed', ?, 0, 'USDC', ?)`,
      )
      .run(victim.taskId, agent.agentId, sig, new Date().toISOString());

    // Attacker replays the public signature.
    const { data } = await callTool("hire_agent", { agentId: agent.agentId, task: "anything", paymentSignature: sig });
    expect(data.taskId).toBe(victim.taskId); // route returns the existing task…
    expect(data.claimToken).toBeUndefined(); // …but MCP refuses to mint a token for it
    expect(data.alreadyHired).toBe(true);
  });

  it("get_task_result requires the claim token and returns output once completed", async () => {
    const agent = makeAgent();
    const { data: hire } = await callTool("hire_agent", { agentId: agent.agentId, task: "do the thing" });
    const taskId = String(hire.taskId);

    // Wrong token — refused, no output leak.
    const denied = await callTool("get_task_result", { taskId, claimToken: "0".repeat(32) });
    expect(denied.isError).toBe(true);

    startTask(taskId);
    completeTask(taskId, "THE-PRIVATE-DELIVERABLE");
    const ok = await callTool("get_task_result", { taskId, claimToken: String(hire.claimToken) });
    expect(ok.data.status).toBe("completed");
    expect(ok.data.output).toBe("THE-PRIVATE-DELIVERABLE");
    // A delivered result must NOT be flagged as a failed tool call.
    expect(ok.isError).toBe(false);
  });

  it("a failed task is a valid result, not a tool error", async () => {
    const agent = makeAgent();
    const { data: hire } = await callTool("hire_agent", { agentId: agent.agentId, task: "doomed" });
    // Re-key: hire made its own task; make a separate failed one to read.
    void hire;
    const failedId = makeFailedTask(agent.agentId, "worker timed out");
    const { data, isError } = await callTool("get_task_result", {
      taskId: failedId,
      claimToken: claimTokenFor(failedId),
    });
    expect(data.status).toBe("failed");
    expect(data.failureReason).toBe("worker timed out");
    expect(isError).toBe(false);
  });

  it("get_receipt returns the public proof and never the output", async () => {
    const agent = makeAgent();
    const { data: hire } = await callTool("hire_agent", { agentId: agent.agentId, task: "receipt me" });
    const taskId = String(hire.taskId);
    startTask(taskId);
    completeTask(taskId, "SECRET-OUTPUT-TEXT");

    const { data } = await callTool("get_receipt", { taskId });
    expect((data.receipt as { taskId: string }).taskId).toBe(taskId);
    expect(JSON.stringify(data)).not.toContain("SECRET-OUTPUT-TEXT");
    expect(data.receiptUrl).toContain(taskId);
  });
});
