import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import AxonPlugin, {
  searchAgents,
  hireAgent,
  getProofScore,
  axonActions,
  hireAxonAgentAction,
  searchAxonAgentsAction,
  axonReceiptAction,
  verifyAxonProofScoreAction,
} from "../src/index.ts";
import type { SolanaAgentKit } from "../src/sak.ts";

const BASE = "https://axon-agents.com";

// ── a tiny fetch mock ─────────────────────────────────────────────────────────
type Res = { ok: boolean; status: number; headers: { get: (k: string) => string | null }; json: () => Promise<any>; text: () => Promise<string> };
const res = (status: number, body: any, headers: Record<string, string> = {}): Res => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});
function mockFetch(routes: Array<{ test: (url: string, method: string) => boolean; res: Res | ((url: string, init?: any) => Res) }>) {
  (globalThis as any).fetch = async (url: any, init?: any): Promise<Res> => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    for (const r of routes) if (r.test(u, method)) return typeof r.res === "function" ? r.res(u, init) : r.res;
    throw new Error(`unmocked fetch: ${method} ${u}`);
  };
}

// a fake SAK agent — free-lane hires never touch wallet/connection
const agent: SolanaAgentKit = {
  wallet: { publicKey: { toBase58: () => "Wa11et" } as any, signTransaction: async (t: any) => t },
  connection: {} as any,
  config: { AXON_ENDPOINT: BASE },
};

test("plugin exposes the four Axon actions and a name", () => {
  assert.equal(AxonPlugin.name, "axon");
  assert.deepEqual(
    axonActions.map((a) => a.name),
    ["AXON_SEARCH_AGENTS", "AXON_HIRE_AGENT", "AXON_RECEIPT", "AXON_VERIFY_PROOF_SCORE"],
  );
  assert.equal(typeof AxonPlugin.initialize, "function");
  for (const a of axonActions) assert.ok(a.schema && typeof a.handler === "function");
});

test("searchAgents returns Proof-Score-ranked agents", async () => {
  mockFetch([{ test: (u) => u.includes("/api/agents?"), res: res(200, { agents: [{ agentId: "a1", name: "A1", proofScore: 940, price: "0.15 USDC" }] }) }]);
  const agents = await searchAgents(BASE, { capability: "research", limit: 3 });
  assert.equal(agents[0].agentId, "a1");
  assert.equal(agents[0].proofScore, 940);
});

test("hireAgent (free lane) creates, polls with claimToken, and returns the output", async () => {
  mockFetch([
    { test: (u) => u.includes("/x402"), res: res(200, {}) }, // free agent
    { test: (u, m) => u.endsWith("/api/tasks") && m === "POST", res: res(201, { taskId: "t1", status: "queued", claimToken: "ct" }) },
    { test: (u) => u.includes("/api/tasks/t1"), res: res(200, { status: "completed", output: "the answer" }) },
  ]);
  const r = await hireAgent(agent, BASE, "a1", "do it", { pollMs: 2, timeoutMs: 1000 });
  assert.equal(r.status, "completed");
  assert.equal(r.output, "the answer");
  assert.equal(r.paid, false);
  assert.equal(r.receiptUrl, `${BASE}/r/t1`);
});

test("hireAgent (paid) pays from the wallet, submits the signature, and returns the output", async () => {
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const kp = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58(); // a valid 32-byte base58
  const treasury = Keypair.generate().publicKey.toBase58();

  // x402 requirements header exactly as the server encodes them (base64 JSON)
  const reqHeader = Buffer.from(
    JSON.stringify({
      version: "x402/1",
      accepts: [{ payToAddress: treasury, asset: "USDC", maxAmountRequired: "150000", extra: { contractAddress: USDC_MINT, decimals: 6 } }],
    }),
  ).toString("base64");

  const paidAgent: SolanaAgentKit = {
    wallet: {
      publicKey: kp.publicKey,
      signTransaction: async (t: any) => {
        t.sign(kp); // real signature so tx.serialize() succeeds
        return t;
      },
    },
    connection: {
      getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1000 }),
      sendRawTransaction: async () => "PAYSIG",
      confirmTransaction: async () => ({ value: { err: null } }),
    } as any,
    config: { AXON_ENDPOINT: BASE },
  };

  let submitted: any = null;
  mockFetch([
    { test: (u) => u.includes("/x402"), res: res(402, {}, { "x-payment-required": reqHeader }) },
    {
      test: (u, m) => u.endsWith("/api/tasks") && m === "POST",
      res: (_u, init) => {
        submitted = JSON.parse(init.body);
        return res(201, { taskId: "tp", status: "queued", claimToken: "ct" });
      },
    },
    { test: (u) => u.includes("/api/tasks/tp"), res: res(200, { status: "completed", output: "paid result" }) },
  ]);

  const r = await hireAgent(paidAgent, BASE, "paid-agent", "do it", { pollMs: 2, timeoutMs: 1000, priorityFeeMicroLamports: 1000 });
  assert.equal(r.paid, true);
  assert.equal(r.costUsdc, 0.15);
  assert.equal(r.output, "paid result");
  // the on-chain signature + payer were submitted with the anonymous hire
  assert.equal(submitted.from, "anonymous");
  assert.equal(submitted.paymentSignature, "PAYSIG");
  assert.equal(submitted.payerWallet, kp.publicKey.toBase58());
});

test("all action schemas are plain ZodObjects (SAK's OpenAI/LangChain converters throw on ZodEffects)", () => {
  for (const a of axonActions) {
    assert.equal((a.schema as any)?.constructor?.name, "ZodObject", `${a.name} schema must be a ZodObject, not a refined ZodEffects`);
  }
  // The one-of (agentId|capability) rule is enforced in the handler, not the schema.
  assert.equal((hireAxonAgentAction.schema as any).safeParse({ task: "x" }).success, true);
});

test("AXON_HIRE_AGENT handler refuses a bare task even if the schema refine is dropped", async () => {
  (globalThis as any).fetch = async () => {
    throw new Error("must not hire anyone");
  };
  const out: any = await hireAxonAgentAction.handler(agent, { task: "do something" });
  assert.equal(out.status, "error"); // guarded in the handler, no network call
});

test("AXON_SEARCH_AGENTS action returns a shaped agent list", async () => {
  mockFetch([{ test: (u) => u.includes("/api/agents?"), res: res(200, { agents: [{ agentId: "a1", name: "A1", proofScore: 951, price: "0.15 USDC", capabilities: ["research"] }] }) }]);
  const out: any = await searchAxonAgentsAction.handler(agent, { capability: "research" });
  assert.equal(out.status, "success");
  assert.equal(out.agents[0].agentId, "a1");
  assert.equal(out.agents[0].proofScore, 951);
});

test("AXON_RECEIPT builds a verifiable receipt URL", async () => {
  const out: any = await axonReceiptAction.handler(agent, { taskId: "abc" });
  assert.equal(out.receiptUrl, `${BASE}/r/abc`);
});

test("AXON_VERIFY_PROOF_SCORE maps the endpoint's `score` to `proofScore`", async () => {
  // the real /proof-score endpoint returns `score`, not `proofScore`
  mockFetch([{ test: (u) => u.includes("/proof-score"), res: res(200, { score: 951, tier: "gold", agentId: "a1" }) }]);
  const out: any = await verifyAxonProofScoreAction.handler(agent, { agentId: "a1" });
  assert.equal(out.status, "success");
  assert.equal(out.proofScore, 951);
  const direct = await getProofScore(BASE, "a1");
  assert.equal((direct as any).score, 951);
});

test("AXON_HIRE_AGENT enforces maxPrice — refuses to pay above the cap, no payment", async () => {
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const kp = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const treasury = Keypair.generate().publicKey.toBase58();
  const reqHeader = Buffer.from(
    JSON.stringify({ version: "x402/1", accepts: [{ payToAddress: treasury, asset: "USDC", maxAmountRequired: "150000", extra: { contractAddress: USDC_MINT, decimals: 6 } }] }),
  ).toString("base64");
  let signed = false;
  // A WORKING connection + signing wallet: without the cap this hire WOULD sign +
  // pay + succeed, so `signed === false` genuinely proves the cap stopped it early.
  const capAgent: SolanaAgentKit = {
    wallet: { publicKey: kp.publicKey, signTransaction: async (t: any) => { signed = true; t.sign(kp); return t; } },
    connection: {
      getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1000 }),
      sendRawTransaction: async () => "PAYSIG",
      confirmTransaction: async () => ({ value: { err: null } }),
    } as any,
    config: { AXON_ENDPOINT: BASE },
  };
  mockFetch([
    { test: (u) => u.includes("/x402"), res: res(402, {}, { "x-payment-required": reqHeader }) },
    { test: (u, m) => u.endsWith("/api/tasks") && m === "POST", res: res(201, { taskId: "tp", status: "queued", claimToken: "ct" }) },
    { test: (u) => u.includes("/api/tasks/tp"), res: res(200, { status: "completed", output: "x" }) },
  ]);
  // cap 0.05 < the 0.15 price → must refuse before any signing/payment
  const out: any = await hireAxonAgentAction.handler(capAgent, { agentId: "pricey", task: "t", maxPrice: "0.05 USDC" });
  assert.equal(out.status, "error");
  assert.equal(signed, false);

  // sanity: raise the cap above the price and the same setup DOES sign + succeed —
  // proving the assertions above depend on the cap, not on a broken payment stub.
  signed = false;
  const ok: any = await hireAxonAgentAction.handler(capAgent, { agentId: "pricey", task: "t", maxPrice: "0.20 USDC" });
  assert.equal(ok.status, "success");
  assert.equal(signed, true);
});
