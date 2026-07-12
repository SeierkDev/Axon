// Tests for the HIRE_ON_AXON action handler itself — the product logic (agent
// selection, free vs paid branching, payment retry, replay, and the ActionResult
// it returns). hireOnAxon.ts imports @elizaos/core as TYPES ONLY (erased at
// runtime), so this runs with just a mocked fetch + a fake runtime/callback — no
// ElizaOS install needed. Run: node --test --import tsx test/action.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHireOnAxonAction } from "../src/actions/hireOnAxon.ts";

// Route the mocked fetch by the tool name in the JSON-RPC body.
function routeFetch(byTool: Record<string, (args: any) => unknown>) {
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const name: string = body.params.name;
    const impl = byTool[name];
    if (!impl) throw new Error(`unexpected tool ${name}`);
    const result = impl(body.params.arguments);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } }) };
  }) as any;
}

const runtime = { getSetting: () => undefined } as any;
const msg = { content: { text: "hire someone to research the top Solana RPCs" } } as any;

async function run(byTool: Record<string, (args: any) => unknown>, config: any = {}) {
  const orig = globalThis.fetch;
  globalThis.fetch = routeFetch(byTool);
  const said: any[] = [];
  const callback = async (c: any) => { said.push(c); return []; };
  try {
    const action = createHireOnAxonAction(config);
    const result = await action.handler(runtime, msg, undefined, undefined, callback);
    return { result: result as any, said };
  } finally {
    globalThis.fetch = orig;
  }
}

test("validate fires on a hire/delegate request, not on chatter", async () => {
  const a = createHireOnAxonAction();
  assert.equal(await a.validate(runtime, { content: { text: "can you hire someone to write copy" } } as any), true);
  assert.equal(await a.validate(runtime, { content: { text: "delegate the research to a specialist" } } as any), true);
  assert.equal(await a.validate(runtime, { content: { text: "hello how are you" } } as any), false);
});

test("free-lane happy path: picks highest Proof Score, returns success + receipt", async () => {
  const { result, said } = await run({
    search_agents: () => ({ agents: [
      { agentId: "low", name: "Low", capabilities: ["research"], proofScore: 200 },
      { agentId: "high", name: "High", capabilities: ["research"], proofScore: 850 },
    ] }),
    hire_agent: (args) => { assert.equal(args.agentId, "high"); return { taskId: "t1", status: "queued", claimToken: "ctok", receiptUrl: "x" }; },
    get_task_result: () => ({ taskId: "t1", status: "completed", output: "the answer" }),
  });
  assert.equal(result.success, true);
  assert.equal(result.data.taskId, "t1");
  assert.match(result.data.receiptUrl, /\/r\/t1$/);
  assert.ok(said.some((c) => String(c.text).includes("the answer")));
});

test("paid agent with NO wallet configured → success:false + payment data, no charge", async () => {
  let hireCalls = 0;
  const { result } = await run({
    search_agents: () => ({ agents: [{ agentId: "paid", name: "Paid", capabilities: ["research"], proofScore: 500 }] }),
    hire_agent: () => { hireCalls++; return { status: "payment_required", price: "0.5 USDC", amount: 0.5, currency: "USDC", payTo: "Trez", network: "solana-mainnet", instructions: "pay" }; },
  });
  assert.equal(result.success, false);
  assert.equal(result.data.paymentRequired, true);
  assert.equal(hireCalls, 1); // never retried without a signature
});

test("paid agent WITH payUsdc → pays, retries with signature, completes", async () => {
  let hireCalls = 0;
  let paidReq: any = null;
  const { result } = await run(
    {
      search_agents: () => ({ agents: [{ agentId: "paid", name: "Paid", capabilities: ["research"], proofScore: 500 }] }),
      hire_agent: (args) => {
        hireCalls++;
        if (!args.paymentSignature) return { status: "payment_required", price: "0.5 USDC", amount: 0.5, currency: "USDC", payTo: "Trez", network: "solana-mainnet", instructions: "pay" };
        assert.equal(args.paymentSignature, "sig123");
        return { taskId: "t9", status: "queued", claimToken: "ctok", receiptUrl: "x" };
      },
      get_task_result: () => ({ taskId: "t9", status: "completed", output: "done" }),
    },
    { payUsdc: async (req: any) => { paidReq = req; return "sig123"; } },
  );
  assert.equal(result.success, true);
  assert.equal(hireCalls, 2); // required → paid → retried
  assert.equal(paidReq.amount, 0.5);
  assert.equal(result.data.taskId, "t9");
});

test("no matching agent → success:false", async () => {
  const { result } = await run({ search_agents: () => ({ agents: [] }) });
  assert.equal(result.success, false);
  assert.match(result.text, /no matching/i);
});

test("a thrown client error is caught → success:false with the error", async () => {
  const { result } = await run({
    search_agents: () => { throw new Error("boom"); },
  });
  // search throws inside the client → surfaces as isError? No: this mock throws in
  // fetch, so the client rejects → handler catch. success:false.
  assert.equal(result.success, false);
});
