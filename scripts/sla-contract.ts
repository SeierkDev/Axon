// End-to-end contract test for task SLAs (Phase 8).
// Run against a running server: `npm run contract:sla`
// (set AXON_CONTRACT_ENDPOINT, defaults to http://localhost:3000).
//
// Covers the HTTP contract: payer-only auth, validation, and the define → get →
// status flow. The penalty-settlement math is unit-tested.

import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AxonClient } from "../src/sdk";

type Json = Record<string, unknown>;
interface ErrorBody { error?: string; code?: string }

function signChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(challenge), keypair.secretKey)).toString("base64");
}

async function request<T = Json>(endpoint: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${endpoint}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

function authHeaders(apiKey?: string): Record<string, string> {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

function assertStatus(label: string, actual: number, expected: number) {
  if (actual !== expected) throw new Error(`${label}: expected HTTP ${expected}, got ${actual}`);
}

function assertError(label: string, result: { status: number; body: ErrorBody }, expectedStatus: number, expectedCode: string) {
  assertStatus(label, result.status, expectedStatus);
  if (result.body.code !== expectedCode) {
    throw new Error(`${label}: expected error code ${expectedCode}, got ${String(result.body.code)}`);
  }
}

async function login(endpoint: string, keypair: Keypair) {
  const walletAddress = keypair.publicKey.toBase58();
  const client = new AxonClient();
  client.init({ endpoint });
  const { challenge } = await client.createAuthChallenge(walletAddress);
  return client.verifyAuthChallenge({ walletAddress, challenge, signature: signChallenge(keypair, challenge) });
}

async function registerAgent(endpoint: string, apiKey: string, agentId: string, wallet: string, keys: Keypair) {
  assertStatus(
    `register ${agentId}`,
    (await request(endpoint, "/api/agents", {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        agentId,
        name: agentId,
        capabilities: ["sla-contract"],
        publicKey: Buffer.from(keys.publicKey.toBytes()).toString("base64"),
        walletAddress: wallet,
      }),
    })).status,
    201
  );
}

async function main() {
  const endpoint = process.env.AXON_CONTRACT_ENDPOINT ?? "http://localhost:3000";
  const suffix = Date.now();

  const payerWallet = Keypair.generate();
  const otherWallet = Keypair.generate();
  const payerAddr = payerWallet.publicKey.toBase58();
  const provider = `sla-p-${suffix}`;

  const payerAuth = await login(endpoint, payerWallet);
  const otherAuth = await login(endpoint, otherWallet);
  await registerAgent(endpoint, payerAuth.apiKey, provider, payerAddr, Keypair.generate());

  // A free task owned by the payer to attach an SLA to.
  const created = await request<{ taskId: string }>(endpoint, "/api/tasks", {
    method: "POST",
    headers: authHeaders(payerAuth.apiKey),
    body: JSON.stringify({ from: payerAddr, to: provider, task: "sla contract task" }),
  });
  assertStatus("create task", created.status, 201);
  const taskId = created.body.taskId;
  if (!taskId) throw new Error("create task: missing taskId");

  const path = `/api/tasks/${taskId}/sla`;
  const valid = JSON.stringify({ deadlineSeconds: 300, penaltyBps: 2500 });

  // 1. Auth required.
  assertError("define without auth", await request<ErrorBody>(endpoint, path, { method: "POST", headers: authHeaders(), body: valid }), 401, "AUTH_REQUIRED");

  // 2. Only the payer can set the SLA.
  assertError("non-payer define", await request<ErrorBody>(endpoint, path, { method: "POST", headers: authHeaders(otherAuth.apiKey), body: valid }), 403, "FORBIDDEN");

  // 3. Validation — penalty out of range and non-positive deadline.
  assertError(
    "bad penaltyBps",
    await request<ErrorBody>(endpoint, path, { method: "POST", headers: authHeaders(payerAuth.apiKey), body: JSON.stringify({ deadlineSeconds: 300, penaltyBps: 0 }) }),
    400,
    "VALIDATION_ERROR"
  );
  assertError(
    "bad deadline",
    await request<ErrorBody>(endpoint, path, { method: "POST", headers: authHeaders(payerAuth.apiKey), body: JSON.stringify({ deadlineSeconds: 0, penaltyBps: 2500 }) }),
    400,
    "VALIDATION_ERROR"
  );

  // 4. Unknown task.
  assertError(
    "unknown task",
    await request<ErrorBody>(endpoint, `/api/tasks/no-such-${suffix}/sla`, { method: "POST", headers: authHeaders(payerAuth.apiKey), body: valid }),
    404,
    "NOT_FOUND"
  );

  // 5. Define succeeds and starts active.
  const defined = await request<{ slaId?: string; status?: string; penaltyBps?: number }>(endpoint, path, {
    method: "POST",
    headers: authHeaders(payerAuth.apiKey),
    body: valid,
  });
  assertStatus("define sla", defined.status, 201);
  if (defined.body.status !== "active") throw new Error(`define: expected status active, got ${String(defined.body.status)}`);
  if (defined.body.penaltyBps !== 2500) throw new Error(`define: expected penaltyBps 2500, got ${String(defined.body.penaltyBps)}`);

  // 6. Public read returns it.
  const got = await request<{ status?: string }>(endpoint, path);
  assertStatus("get sla", got.status, 200);
  if (got.body.status !== "active") throw new Error(`get: expected status active, got ${String(got.body.status)}`);

  // 7. A task with no SLA reads 404.
  assertError("get missing sla", await request<ErrorBody>(endpoint, `/api/tasks/no-such-${suffix}/sla`), 404, "NOT_FOUND");

  console.log("✓ sla contract: payer-only auth → validation → define → get → status");
}

main().catch((err) => {
  console.error("✗ sla contract failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
