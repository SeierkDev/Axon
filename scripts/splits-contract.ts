// End-to-end contract test for multi-agent escrow splits (Phase 8).
// Run against a running server: `npm run contract:splits`
// (set AXON_CONTRACT_ENDPOINT, defaults to http://localhost:3000).
//
// Covers the HTTP contract: auth, body validation, payer-only ownership, and the
// paid-task guard. Settlement math is covered by the unit suite.

import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AxonClient } from "../src/sdk";

type Json = Record<string, unknown>;

interface ErrorBody {
  error?: string;
  code?: string;
}

function signChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(
    nacl.sign.detached(new TextEncoder().encode(challenge), keypair.secretKey)
  ).toString("base64");
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
        capabilities: ["splits-contract"],
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
  const a = `split-a-${suffix}`;
  const b = `split-b-${suffix}`;

  const payerAuth = await login(endpoint, payerWallet);
  const otherAuth = await login(endpoint, otherWallet);
  await registerAgent(endpoint, payerAuth.apiKey, a, payerAddr, Keypair.generate());
  await registerAgent(endpoint, payerAuth.apiKey, b, payerAddr, Keypair.generate());

  // Create a (free) task owned by the payer to define a split on.
  const created = await request<{ taskId: string }>(endpoint, "/api/tasks", {
    method: "POST",
    headers: authHeaders(payerAuth.apiKey),
    body: JSON.stringify({ from: payerAddr, to: a, task: "splits contract task" }),
  });
  assertStatus("create task", created.status, 201);
  const taskId = created.body.taskId;
  if (!taskId) throw new Error("create task: missing taskId");

  const valid = JSON.stringify({ recipients: [{ agentId: a, shareBps: 6000 }, { agentId: b, shareBps: 4000 }] });
  const path = `/api/tasks/${taskId}/splits`;

  // 1. Auth required.
  assertError(
    "define split without auth",
    await request<ErrorBody>(endpoint, path, { method: "POST", headers: authHeaders(), body: valid }),
    401,
    "AUTH_REQUIRED"
  );

  // 2. Body validation — shares must sum to 10000.
  assertError(
    "shares must sum to 10000",
    await request<ErrorBody>(endpoint, path, {
      method: "POST",
      headers: authHeaders(payerAuth.apiKey),
      body: JSON.stringify({ recipients: [{ agentId: a, shareBps: 6000 }, { agentId: b, shareBps: 3000 }] }),
    }),
    400,
    "VALIDATION_ERROR"
  );

  // 3. At least two recipients.
  assertError(
    "needs at least two recipients",
    await request<ErrorBody>(endpoint, path, {
      method: "POST",
      headers: authHeaders(payerAuth.apiKey),
      body: JSON.stringify({ recipients: [{ agentId: a, shareBps: 10000 }] }),
    }),
    400,
    "VALIDATION_ERROR"
  );

  // 4. Only the payer can set the split.
  assertError(
    "non-payer cannot set split",
    await request<ErrorBody>(endpoint, path, { method: "POST", headers: authHeaders(otherAuth.apiKey), body: valid }),
    403,
    "FORBIDDEN"
  );

  // 5. Splits require a paid task — this one is free.
  assertError(
    "free task rejected",
    await request<ErrorBody>(endpoint, path, { method: "POST", headers: authHeaders(payerAuth.apiKey), body: valid }),
    400,
    "VALIDATION_ERROR"
  );

  // 6. GET is payer-only, and returns an (empty) view for a task with no split.
  assertError(
    "view split without auth",
    await request<ErrorBody>(endpoint, path),
    401,
    "AUTH_REQUIRED"
  );
  const view = await request<{ taskId: string; splits: unknown[] }>(endpoint, path, { headers: authHeaders(payerAuth.apiKey) });
  assertStatus("payer views split", view.status, 200);
  if (!Array.isArray(view.body.splits)) throw new Error("payer view: expected a splits array");

  console.log("✓ splits contract: auth → validation → payer-only → paid-task guard → view");
}

main().catch((err) => {
  console.error("✗ splits contract failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
