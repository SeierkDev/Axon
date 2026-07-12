// Standalone tests for the Axon MCP client — no ElizaOS needed, just a mocked
// fetch that speaks the same JSON-RPC/MCP envelope Axon's /mcp route returns.
// Run: node --test --import tsx test/client.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AxonClient, AxonError, isPaymentRequired, isHired } from "../src/client.ts";

// Wrap a tool result the way Axon's /mcp route does: JSON-RPC → content[0].text.
function mcpEnvelope(result: unknown, isError = false) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError } }),
  };
}
function withFetch(handler: (body: any) => any, fn: () => Promise<void>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => handler(JSON.parse(init.body))) as any;
  return fn().finally(() => { globalThis.fetch = orig; });
}

test("searchAgents posts a tools/call and parses the content block", async () => {
  await withFetch(
    (body) => {
      assert.equal(body.method, "tools/call");
      assert.equal(body.params.name, "search_agents");
      assert.equal(body.params.arguments.query, "research solana rpcs");
      return mcpEnvelope({ agents: [{ agentId: "a1", name: "Researcher", capabilities: ["research"], proofScore: 700 }] });
    },
    async () => {
      const c = new AxonClient("https://axon-agents.com");
      const { agents } = await c.searchAgents({ query: "research solana rpcs" });
      assert.equal(agents[0].agentId, "a1");
      assert.equal(agents[0].proofScore, 700);
    },
  );
});

test("hireAgent surfaces payment_required for paid agents", async () => {
  await withFetch(
    () => mcpEnvelope({ status: "payment_required", price: "0.5 USDC", amount: 0.5, currency: "USDC", payTo: "Trez...", network: "solana-mainnet", instructions: "Pay 0.5 USDC…" }),
    async () => {
      const c = new AxonClient();
      const r = await c.hireAgent({ agentId: "a1", task: "do it" });
      assert.ok(isPaymentRequired(r));
      if (isPaymentRequired(r)) assert.equal(r.amount, 0.5);
      assert.equal(isHired(r), false);
    },
  );
});

test("hireAgent free lane returns a claim token", async () => {
  await withFetch(
    () => mcpEnvelope({ taskId: "t1", status: "queued", claimToken: "ctok", receiptUrl: "https://axon-agents.com/r/t1" }),
    async () => {
      const c = new AxonClient();
      const r = await c.hireAgent({ agentId: "a1", task: "free work" });
      assert.ok(isHired(r));
      if (isHired(r)) assert.equal(r.claimToken, "ctok");
    },
  );
});

test("tool errors (isError) throw AxonError", async () => {
  await withFetch(
    () => mcpEnvelope({ error: "invalid claim token for this task" }, true),
    async () => {
      const c = new AxonClient();
      await assert.rejects(() => c.getTaskResult({ taskId: "t1", claimToken: "bad" }), AxonError);
    },
  );
});

test("waitForResult polls until the task completes", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return mcpEnvelope(calls < 3 ? { taskId: "t1", status: "running" } : { taskId: "t1", status: "completed", output: "done" });
    },
    async () => {
      const c = new AxonClient();
      const r = await c.waitForResult({ taskId: "t1", claimToken: "ctok" }, { attempts: 5, intervalMs: 0, sleep: async () => {} });
      assert.equal(r.status, "completed");
      assert.equal(r.output, "done");
      assert.equal(calls, 3);
    },
  );
});

test("waitForResult keeps polling through non-terminal statuses (queued/payment_pending), not just 'running'", async () => {
  const seq = ["payment_pending", "queued", "running", "completed"];
  let i = 0;
  await withFetch(
    () => mcpEnvelope({ taskId: "t1", status: seq[Math.min(i++, seq.length - 1)], ...(seq[Math.min(i - 1, seq.length - 1)] === "completed" ? { output: "ok" } : {}) }),
    async () => {
      const c = new AxonClient();
      const r = await c.waitForResult({ taskId: "t1", claimToken: "ctok" }, { attempts: 10, intervalMs: 0, sleep: async () => {} });
      assert.equal(r.status, "completed"); // did not stop early on payment_pending/queued
      assert.equal(i, 4);
    },
  );
});

test("waitForResult returns the last poll if it never reaches terminal within the budget", async () => {
  await withFetch(
    () => mcpEnvelope({ taskId: "t1", status: "running" }),
    async () => {
      const c = new AxonClient();
      const r = await c.waitForResult({ taskId: "t1", claimToken: "ctok" }, { attempts: 3, intervalMs: 0, sleep: async () => {} });
      assert.equal(r.status, "running"); // budget exhausted, returns last known
    },
  );
});

test("HTTP failure throws AxonError", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as any;
  try {
    const c = new AxonClient();
    await assert.rejects(() => c.searchAgents({ query: "x" }), AxonError);
  } finally {
    globalThis.fetch = orig;
  }
});
