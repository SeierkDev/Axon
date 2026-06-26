// End-to-end contract test for bidding & quotes (Phase 8).
// Run against a running server: `npm run contract:bidding`
// (set AXON_CONTRACT_ENDPOINT, defaults to http://localhost:3000).
//
// Covers: open a task → discover by poster → bid → duplicate guard → accept
// requires payment for a paid bid (402) → cancel. Auth is exercised throughout.

import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AxonClient } from "../src/sdk";

type Json = Record<string, unknown>;

interface HttpResult<T = Json> {
  status: number;
  body: T;
}

interface ErrorBody {
  error?: string;
  code?: string;
}

function signChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(
    nacl.sign.detached(new TextEncoder().encode(challenge), keypair.secretKey)
  ).toString("base64");
}

async function request<T = Json>(endpoint: string, path: string, init?: RequestInit): Promise<HttpResult<T>> {
  const res = await fetch(`${endpoint}${path}`, init);
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body };
}

function authHeaders(apiKey?: string): Record<string, string> {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

function assertStatus(label: string, actual: number, expected: number) {
  if (actual !== expected) throw new Error(`${label}: expected HTTP ${expected}, got ${actual}`);
}

function assertError(label: string, result: HttpResult<ErrorBody>, expectedStatus: number, expectedCode: string) {
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
        capabilities: ["bidding-contract", "research"],
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

  const posterWallet = Keypair.generate();
  const bidderWallet = Keypair.generate();
  const posterAddr = posterWallet.publicKey.toBase58();
  const bidderAddr = bidderWallet.publicKey.toBase58();
  const posterAgent = `bid-poster-${suffix}`;
  const bidderAgent = `bid-worker-${suffix}`;

  const posterAuth = await login(endpoint, posterWallet);
  const bidderAuth = await login(endpoint, bidderWallet);
  await registerAgent(endpoint, posterAuth.apiKey, posterAgent, posterAddr, Keypair.generate());
  await registerAgent(endpoint, bidderAuth.apiKey, bidderAgent, bidderAddr, Keypair.generate());

  // 1. Open a task (poster). Unauthenticated post is rejected.
  const body = JSON.stringify({ from: posterAgent, task: "Summarize x402", capabilities: ["research"], maxBudget: "0.10 USDC" });
  assertError(
    "open task without auth",
    await request<ErrorBody>(endpoint, "/api/open-tasks", { method: "POST", headers: authHeaders(), body }),
    401,
    "AUTH_REQUIRED"
  );
  const created = await request<{ openTaskId: string }>(endpoint, "/api/open-tasks", {
    method: "POST",
    headers: authHeaders(posterAuth.apiKey),
    body,
  });
  assertStatus("open task", created.status, 201);
  const openTaskId = created.body.openTaskId;
  if (!openTaskId) throw new Error("open task: missing openTaskId");

  // 2. Discover it via the poster filter.
  const listed = await request<{ openTasks: { openTaskId: string }[] }>(
    endpoint,
    `/api/open-tasks?from=${encodeURIComponent(posterAgent)}`
  );
  assertStatus("discover by poster", listed.status, 200);
  if (!listed.body.openTasks.some((t) => t.openTaskId === openTaskId)) {
    throw new Error("discover by poster: open task not returned");
  }

  // 3. Bid (bidder). A second bid from the same agent is rejected.
  const bidBody = JSON.stringify({ agentId: bidderAgent, price: "0.05 USDC", message: "I can do this" });
  const bid = await request<{ bidId: string }>(endpoint, `/api/open-tasks/${openTaskId}/bids`, {
    method: "POST",
    headers: authHeaders(bidderAuth.apiKey),
    body: bidBody,
  });
  assertStatus("submit bid", bid.status, 201);
  const bidId = bid.body.bidId;

  assertError(
    "duplicate bid rejected",
    await request<ErrorBody>(endpoint, `/api/open-tasks/${openTaskId}/bids`, {
      method: "POST",
      headers: authHeaders(bidderAuth.apiKey),
      body: bidBody,
    }),
    409,
    "CONFLICT"
  );

  // 4. The bid shows up.
  const withBids = await request<{ bids: unknown[] }>(endpoint, `/api/open-tasks/${openTaskId}`);
  assertStatus("get open task", withBids.status, 200);
  if (withBids.body.bids.length !== 1) throw new Error("get open task: expected exactly 1 bid");

  // 5. A paid bid can't be accepted without a payment signature.
  assertError(
    "accept paid bid without payment",
    await request<ErrorBody>(endpoint, `/api/open-tasks/${openTaskId}/accept`, {
      method: "POST",
      headers: authHeaders(posterAuth.apiKey),
      body: JSON.stringify({ bidId }),
    }),
    402,
    "PAYMENT_REQUIRED"
  );

  // 6. Only the poster can accept/cancel.
  assertError(
    "non-poster cannot accept",
    await request<ErrorBody>(endpoint, `/api/open-tasks/${openTaskId}/accept`, {
      method: "POST",
      headers: authHeaders(bidderAuth.apiKey),
      body: JSON.stringify({ bidId }),
    }),
    403,
    "FORBIDDEN"
  );

  // 7. Cancel (poster), then it stops taking bids.
  assertStatus(
    "cancel open task",
    (await request(endpoint, `/api/open-tasks/${openTaskId}`, { method: "DELETE", headers: authHeaders(posterAuth.apiKey) })).status,
    200
  );
  const afterCancel = await request<{ openTask: { status: string } }>(endpoint, `/api/open-tasks/${openTaskId}`);
  if (afterCancel.body.openTask.status !== "cancelled") {
    throw new Error(`cancel: expected status 'cancelled', got '${afterCancel.body.openTask.status}'`);
  }

  console.log("✓ bidding contract: open → discover → bid → dup-guard → paid-accept-402 → auth → cancel");
}

main().catch((err) => {
  console.error("✗ bidding contract failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
