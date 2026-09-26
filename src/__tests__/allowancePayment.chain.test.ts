// Allowance payments against a real chain: the actual contract on a local Anvil node, the actual
// hire route, the actual reconciler. No mocked chain anywhere.
//
// This is the test that matters for this feature. The SDK's payment header was wrong for months while
// every mocked test passed, because a mock answers with whatever its author believed. Here the
// contract answers.
//
// Skips when Anvil or the compiled contract is missing (`cd contracts && forge build`).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// $AXON payments are switched on by a variable read once, at import. The token is the first contract
// the deployer creates on a fresh Anvil node, which always lands at the same address, so it can be
// named before anything is imported. beforeAll checks the deployment really landed there.
const PREDICTED_AXON = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
vi.hoisted(() => {
  process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
});

// A local chain has no $AXON pool to read a price from. Pin one: 1 $AXON per ETH, in the pool's own
// sqrt form. Everything else about the quote, the reservation and the settlement stays real.
const SQRT_PRICE = 2n ** 96n;
vi.mock("@/lib/axonPool", async (original) => ({
  ...(await original<typeof import("@/lib/axonPool")>()),
  readPoolPrice: async () => ({ sqrtPriceX96: 2n ** 96n, axonPerEth: 1 }),
}));
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createPublicClient, createWalletClient, http, parseEther, type Hex, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { POST } from "@/app/api/tasks/route";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { getDb } from "@/lib/db";
import { releasePayment, refundPayment } from "@/lib/payments";
import { reconcileAllowances } from "@/lib/allowancePayment";
import { reservationState, readAccount } from "@/lib/allowanceChain";
import { taskKey } from "@/lib/allowancePolicy";
import { resetRpcCircuit } from "@/lib/evm";
import { createAllowanceKey } from "@/lib/allowanceKeys";
import { POST as mcpPost } from "@/app/mcp/route";
import type { Agent } from "@/sdk/types";

const ANVIL = [path.join(homedir(), ".foundry/bin/anvil"), "anvil"].find((p) => p === "anvil" || existsSync(p))!;
const ARTIFACTS = path.join(process.cwd(), "contracts/out");
const ALLOWANCE_ARTIFACT = path.join(ARTIFACTS, "Allowance.sol/Allowance.json");
const TOKEN_ARTIFACT = path.join(ARTIFACTS, "Allowance.t.sol/MockAxon.json");
const available = existsSync(ALLOWANCE_ARTIFACT) && existsSync(TOKEN_ARTIFACT);

// Anvil's standard development keys.
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OWNER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const OWNER = privateKeyToAccount(OWNER_KEY);
const OPERATOR_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const RECEIVER = "0x000000000000000000000000000000000000bEEF" as const;

const PRICE = "0.0005 ETH";
const PER_TASK = parseEther("0.0005");
const PER_DAY = parseEther("0.005");

let anvil: ChildProcess;
let rpc: string;
let allowance: Hex;
let axon: Hex;
let allowanceAbi: Abi;
let tokenAbi: Abi;
let apiKey: string;

const pub = () => createPublicClient({ transport: http(rpc) });
const ownerWallet = () => createWalletClient({ account: OWNER, transport: http(rpc) });

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("anvil did not start");
}

async function deploy(artifact: string, args: unknown[]): Promise<{ address: Hex; abi: Abi }> {
  const json = JSON.parse(readFileSync(artifact, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  const wallet = createWalletClient({ account: DEPLOYER, transport: http(rpc) });
  const hash = await wallet.deployContract({ abi: json.abi, bytecode: json.bytecode.object, args, chain: null });
  const receipt = await pub().waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress!, abi: json.abi };
}

async function ownerCall(address: Hex, abi: Abi, functionName: string, args: unknown[], value?: bigint) {
  const hash = await ownerWallet().writeContract({ address, abi, functionName, args, value, chain: null });
  const receipt = await pub().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

async function now(): Promise<bigint> {
  return (await pub().getBlock()).timestamp;
}

function paidAgent(price = PRICE, acceptsAxon = false): string {
  const agent: Agent = {
    agentId: `allow-${randomUUID().slice(0, 8)}`,
    name: "Allowance Hireable",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: RECEIVER,
    provider: "anthropic",
    price,
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(agent);
  if (acceptsAxon) getDb().prepare("UPDATE agents SET accepts_axon = 1 WHERE agent_id = ?").run(agent.agentId);
  return agent.agentId;
}

async function hire(to: string, extra: Record<string, unknown> = {}, key: string | null = apiKey) {
  const req = new NextRequest("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: JSON.stringify({ from: key ? OWNER.address.toLowerCase() : "anonymous", to, task: "research this", paymentMethod: "allowance", ...extra }),
  });
  const res = await POST(req);
  return { res, body: (await res.json()) as { taskId?: string; status?: string; error?: { message?: string } | string } };
}

const reservationRow = (taskId: string) =>
  getDb().prepare("SELECT * FROM allowance_reservations WHERE task_id = ?").get(taskId) as
    { state: string; reserve_tx: string; tx_id: string; close_tx: string | null } | undefined;

describe.skipIf(!available)("allowance payments on a real chain", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const port = 18_545 + Math.floor(Math.random() * 1000);
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn(ANVIL, ["--port", String(port), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
    await waitFor(rpc);

    const token = await deploy(TOKEN_ARTIFACT, []);
    axon = token.address;
    if (axon.toLowerCase() !== PREDICTED_AXON.toLowerCase()) throw new Error(`token landed at ${axon}, not ${PREDICTED_AXON}`);
    tokenAbi = token.abi;
    const operator = privateKeyToAccount(OPERATOR_KEY as Hex).address;
    const c = await deploy(ALLOWANCE_ARTIFACT, [RECEIVER, axon, DEPLOYER.address, operator]);
    allowance = c.address;
    allowanceAbi = c.abi;

    process.env.AXON_RPC_URL = rpc;
    process.env.AXON_ALLOWANCE_ADDRESS = allowance;
    process.env.AXON_ALLOWANCE_OPERATOR_KEY = OPERATOR_KEY;
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = axon;
    resetRpcCircuit();

    // The owner funds an ETH allowance and sets the default rules, from their own wallet.
    await ownerCall(allowance, allowanceAbi, "deposit", [], parseEther("0.01"));
    await ownerCall(allowance, allowanceAbi, "setRules", ["0x0000000000000000000000000000000000000000", PER_TASK, PER_DAY, (await now()) + 30n * 86_400n]);

    apiKey = createApiKey(OWNER.address).apiKey;
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
    delete process.env.AXON_ALLOWANCE_ADDRESS;
    delete process.env.AXON_ALLOWANCE_OPERATOR_KEY;
    delete process.env.AXON_SETTLEMENT_TOKEN_ADDRESS;
    delete process.env.AXON_RPC_URL;
  });

  it("a hire reserves on chain and the task starts paid", async () => {
    const agent = paidAgent();
    const { res, body } = await hire(agent);
    expect(res.status).toBe(201);
    expect(body.status).toBe("queued");

    const row = reservationRow(body.taskId!)!;
    expect(row.state).toBe("reserved");
    expect(await reservationState(taskKey(body.taskId!))).toBe("reserved");

    const ledger = getDb().prepare("SELECT funding_source, incoming_signature, status FROM transactions WHERE tx_id = ?")
      .get(row.tx_id) as { funding_source: string; incoming_signature: string; status: string };
    expect(ledger).toEqual({ funding_source: "allowance", incoming_signature: row.reserve_tx, status: "escrow" });
  });

  it("completion settles to the receiver; the reconciler does it, and only once", async () => {
    const agent = paidAgent();
    const { body } = await hire(agent);
    const before = await pub().getBalance({ address: RECEIVER });

    releasePayment(body.taskId!);
    const first = await reconcileAllowances();
    expect(first.settled).toBeGreaterThanOrEqual(1);
    expect(await reservationState(taskKey(body.taskId!))).toBe("settled");
    expect(reservationRow(body.taskId!)!.state).toBe("settled");
    expect((await pub().getBalance({ address: RECEIVER })) - before).toBe(PER_TASK);

    const second = await reconcileAllowances();
    expect(second.settled).toBe(0);
  });

  it("a refund releases the money back and gives the day back", async () => {
    const agent = paidAgent();
    const { body } = await hire(agent);
    const reserved = await readAccount(OWNER.address);

    refundPayment(body.taskId!);
    await reconcileAllowances();
    expect(await reservationState(taskKey(body.taskId!))).toBe("released");
    const after = await readAccount(OWNER.address);
    expect(after.available - reserved.available).toBe(PER_TASK);
    expect(reserved.spentToday - after.spentToday).toBe(PER_TASK);
  });

  it("a hire over the per-task limit is refused in words and sends nothing", async () => {
    const agent = paidAgent("0.001 ETH");
    const operator = privateKeyToAccount(OPERATOR_KEY as Hex).address;
    const nonceBefore = await pub().getTransactionCount({ address: operator });

    const { res, body } = await hire(agent);
    expect(res.status).toBe(402);
    expect(JSON.stringify(body)).toMatch(/per-task limit/);
    expect(await pub().getTransactionCount({ address: operator })).toBe(nonceBefore);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE to_agent = ?").get(agent)).toEqual({ n: 0 });
  });

  it("a reservation whose task was never written is released", async () => {
    const agent = paidAgent();
    const { body } = await hire(agent);
    const row = reservationRow(body.taskId!)!;
    getDb().prepare("DELETE FROM transactions WHERE tx_id = ?").run(row.tx_id);

    await reconcileAllowances();
    expect(await reservationState(taskKey(body.taskId!))).toBe("released");
  });

  it("an owner's reclaim after the timeout is recorded, not fought", async () => {
    const agent = paidAgent();
    const { body } = await hire(agent);
    const key = taskKey(body.taskId!);

    await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_increaseTime", params: [86_401] }) });
    await ownerCall(allowance, allowanceAbi, "reclaim", [key]);

    releasePayment(body.taskId!); // the task completed after all
    const r = await reconcileAllowances();
    expect(r.synced).toBeGreaterThanOrEqual(1);
    expect(reservationRow(body.taskId!)!.state).toBe("reclaimed");
  });

  it("pays in $AXON at a quote, and settles the quoted amount", async () => {
    const agent = paidAgent(PRICE, true);
    const units = parseEther("250");
    await ownerCall(axon, tokenAbi, "mint", [OWNER.address, parseEther("10000")]);
    await ownerCall(axon, tokenAbi, "approve", [allowance, parseEther("10000")]);
    await ownerCall(allowance, allowanceAbi, "depositToken", [axon, parseEther("10000")]);
    await ownerCall(allowance, allowanceAbi, "setRules", [axon, parseEther("1000"), parseEther("5000"), (await now()) + 30n * 86_400n]);

    const quoteId = randomUUID();
    const created = new Date();
    getDb().prepare(`
      INSERT INTO axon_quotes (quote_id, reference, eth_wei, axon_units, sqrt_price_x96, pay_to, created_at, expires_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
    `).run(quoteId, PER_TASK.toString(), units.toString(), SQRT_PRICE.toString(), RECEIVER, created.toISOString(), new Date(created.getTime() + 600_000).toISOString());

    const { res, body } = await hire(agent, { quoteId });
    expect(res.status).toBe(201);
    const row = reservationRow(body.taskId!)!;
    const ledger = getDb().prepare("SELECT currency, funding_source FROM transactions WHERE tx_id = ?").get(row.tx_id);
    expect(ledger).toEqual({ currency: "AXON", funding_source: "allowance" });
    const quote = getDb().prepare("SELECT tx_hash FROM axon_quotes WHERE quote_id = ?").get(quoteId) as { tx_hash: string };
    expect(quote.tx_hash).toBe(row.reserve_tx);

    releasePayment(body.taskId!);
    await reconcileAllowances();
    const received = await pub().readContract({ address: axon, abi: tokenAbi, functionName: "balanceOf", args: [RECEIVER] });
    expect(received).toBe(units);
  });

  it("payIn AXON over plain REST gets a quote of its own, so two hirers of one agent both pay", async () => {
    const agent = paidAgent(PRICE, true);
    const first = await hire(agent, { payIn: "AXON" });
    const second = await hire(agent, { payIn: "AXON" });
    expect(first.res.status).toBe(201);
    expect(second.res.status).toBe(201);

    const quotes = getDb().prepare(`
      SELECT q.quote_id, q.axon_units FROM allowance_reservations r
      JOIN axon_quotes q ON q.tx_hash = r.reserve_tx WHERE r.task_id IN (?, ?)
    `).all(first.body.taskId!, second.body.taskId!) as { quote_id: string; axon_units: string }[];
    expect(new Set(quotes.map((q) => q.quote_id)).size).toBe(2);
    // 0.0005 ETH at the pinned 1:1 price.
    expect(quotes.every((q) => q.axon_units === PER_TASK.toString())).toBe(true);

    refundPayment(first.body.taskId!);
    refundPayment(second.body.taskId!);
    await reconcileAllowances();
    expect(await reservationState(taskKey(first.body.taskId!))).toBe("released");
  });

  it("an allowance cannot be spent without an API key, or by naming a wallet", async () => {
    const agent = paidAgent();
    const anon = await hire(agent, {}, null);
    expect(anon.res.status).toBe(400);
    const stray = await hire(agent, { paymentMethod: undefined, quoteId: "q" });
    expect(stray.res.status).toBe(400);
  });

  it("an allowance key hires and pays, and the reservation remembers which key", async () => {
    const key = createAllowanceKey(OWNER.address, { label: "Claude" });
    const agent = paidAgent();
    const { res, body } = await hire(agent, {}, key.apiKey);
    expect(res.status).toBe(201);
    const row = getDb().prepare("SELECT api_key_id, eth_wei FROM allowance_reservations WHERE task_id = ?")
      .get(body.taskId!) as { api_key_id: string; eth_wei: string };
    expect(row).toEqual({ api_key_id: key.keyId, eth_wei: PER_TASK.toString() });

    releasePayment(body.taskId!);
    await reconcileAllowances();
    expect(await reservationState(taskKey(body.taskId!))).toBe("settled");
  });

  // ── MCP: the way Claude, Cursor and Grok actually arrive ──────────────────

  async function mcp(name: string, args: Record<string, unknown>, key: string | null) {
    const res = await mcpPost(new NextRequest("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }));
    const json = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
    return { isError: json.result.isError, body: JSON.parse(json.result.content[0].text) as Record<string, unknown> };
  }

  it("MCP: hire_agent with an allowance key pays by itself, and the claim token reads the result", async () => {
    const key = createAllowanceKey(OWNER.address, { label: "Claude" });
    const agent = paidAgent();
    const hired = await mcp("hire_agent", { agentId: agent, task: "summarise this" }, key.apiKey);
    expect(hired.isError).toBe(false);
    expect(hired.body.paidFrom).toBe("allowance");
    expect(await reservationState(taskKey(String(hired.body.taskId)))).toBe("reserved");

    const result = await mcp("get_task_result", { taskId: hired.body.taskId, claimToken: hired.body.claimToken }, null);
    expect(result.isError).toBe(false);
    expect(result.body.status).toBe("queued");
  });

  it("MCP: a retry with the same idempotency key returns the same task and pays once", async () => {
    const key = createAllowanceKey(OWNER.address);
    const agent = paidAgent();
    const first = await mcp("hire_agent", { agentId: agent, task: "once", idempotencyKey: "hire-once-0001" }, key.apiKey);
    const again = await mcp("hire_agent", { agentId: agent, task: "once", idempotencyKey: "hire-once-0001" }, key.apiKey);
    expect(first.isError).toBe(false);
    expect(again.isError).toBe(false);
    expect(typeof first.body.taskId).toBe("string");
    expect(again.body.taskId).toBe(first.body.taskId);
    expect(again.body.alreadyHired).toBe(true);
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM allowance_reservations WHERE task_id = ?").get(String(first.body.taskId));
    expect(n).toEqual({ n: 1 });
  });

  it("MCP: over a limit, the assistant is told why in words and nothing is sent", async () => {
    const key = createAllowanceKey(OWNER.address, { maxPerTaskWei: parseEther("0.0001"), maxPerDayWei: parseEther("0.001") });
    const operator = privateKeyToAccount(OPERATOR_KEY as Hex).address;
    const nonceBefore = await pub().getTransactionCount({ address: operator });
    const hired = await mcp("hire_agent", { agentId: paidAgent(), task: "too dear" }, key.apiKey);
    expect(hired.isError).toBe(true);
    expect(String(hired.body.error)).toMatch(/this key's per-task limit/);
    expect(await pub().getTransactionCount({ address: operator })).toBe(nonceBefore);
  });

  it("MCP: get_allowance shows what is left, including the key's own limits", async () => {
    const key = createAllowanceKey(OWNER.address, { maxPerTaskWei: parseEther("0.0002"), maxPerDayWei: parseEther("0.001") });
    const r = await mcp("get_allowance", {}, key.apiKey);
    expect(r.isError).toBe(false);
    const accounts = r.body.accounts as { token: string; configured: boolean; maxPerTask: string }[];
    expect(accounts.find((a) => a.token === "ETH")).toMatchObject({ configured: true, maxPerTask: "0.0005" });
    expect(r.body.key).toMatchObject({ maxPerTask: "0.0002", maxPerDay: "0.001" });
  });

  it("MCP: without a key a paid hire still returns payment requirements, and says an allowance exists", async () => {
    const hired = await mcp("hire_agent", { agentId: paidAgent(), task: "x" }, null);
    expect(hired.body.status).toBe("payment_required");
    expect(String(hired.body.orUseAnAllowance)).toMatch(/allowance key/);
    const noKey = await mcp("get_allowance", {}, null);
    expect(noKey.isError).toBe(true);
  });

  it("a flood of simultaneous hires never spends past the day's limit, and each one that fits is paid", async () => {
    // Fresh wallet so the day starts empty: 0.005 a day, 0.0005 a hire, room for exactly ten.
    const floodKey = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as const; // anvil #5
    const flooder = privateKeyToAccount(floodKey);
    const w = createWalletClient({ account: flooder, transport: http(rpc) });
    for (const [fn, args, value] of [
      ["deposit", [], parseEther("0.1")],
      ["setRules", ["0x0000000000000000000000000000000000000000", PER_TASK, PER_DAY, (await now()) + 86_400n]],
    ] as const) {
      const hash = await w.writeContract({ address: allowance, abi: allowanceAbi, functionName: fn, args: args as never, value: value as never, chain: null });
      await pub().waitForTransactionReceipt({ hash });
    }
    const key = createApiKey(flooder.address).apiKey;
    const agent = paidAgent();

    const results = await Promise.all(Array.from({ length: 14 }, (_, i) => {
      const req = new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ from: flooder.address.toLowerCase(), to: agent, task: `flood ${i}`, paymentMethod: "allowance" }),
      });
      return POST(req).then(async (res) => ({ status: res.status, body: await res.json() }));
    }));

    const paid = results.filter((r) => r.status === 201);
    const account = await readAccount(flooder.address);
    expect(account.spentToday).toBeLessThanOrEqual(PER_DAY);
    expect(account.reserved).toBe(BigInt(paid.length) * PER_TASK);
    // Everything that fitted went through: a hire must never fail for our own plumbing.
    expect(paid.length).toBe(10);
    const refused = results.filter((r) => r.status !== 201);
    expect(refused.every((r) => /limit/.test(JSON.stringify(r.body)))).toBe(true);
  });

  it("a key's own limit refuses a hire the allowance would allow, and sends nothing", async () => {
    const key = createAllowanceKey(OWNER.address, { maxPerTaskWei: parseEther("0.0001"), maxPerDayWei: parseEther("0.001") });
    const operator = privateKeyToAccount(OPERATOR_KEY as Hex).address;
    const nonceBefore = await pub().getTransactionCount({ address: operator });

    const { res, body } = await hire(paidAgent(), {}, key.apiKey);
    expect(res.status).toBe(402);
    expect(JSON.stringify(body)).toMatch(/this key's per-task limit/);
    expect(await pub().getTransactionCount({ address: operator })).toBe(nonceBefore);
  });
});
