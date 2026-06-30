// End-to-end contract test for abuse reporting & fee policy (Phase 9).
// Run against a running server: `npm run contract:abuse`
// (set AXON_CONTRACT_ENDPOINT, defaults to http://localhost:3000).
//
// Covers: auth, validation, self-report + duplicate guards, the moderation queue
// and resolution (moderation is open in dev), and the public fee policy.

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
        capabilities: ["abuse-contract"],
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

  const reporterWallet = Keypair.generate();
  const ownerWallet = Keypair.generate();
  const reporterAddr = reporterWallet.publicKey.toBase58();
  const ownerAddr = ownerWallet.publicKey.toBase58();
  const target = `victim-${suffix}`; // owned by ownerWallet
  const own = `mine-${suffix}`; // owned by reporterWallet

  const reporterAuth = await login(endpoint, reporterWallet);
  const ownerAuth = await login(endpoint, ownerWallet);
  await registerAgent(endpoint, ownerAuth.apiKey, target, ownerAddr, Keypair.generate());
  await registerAgent(endpoint, reporterAuth.apiKey, own, reporterAddr, Keypair.generate());

  const valid = JSON.stringify({ targetAgent: target, reason: "non_delivery", details: "took payment, no output" });

  // 1. Auth required.
  assertError("file without auth", await request<ErrorBody>(endpoint, "/api/abuse-reports", { method: "POST", headers: authHeaders(), body: valid }), 401, "AUTH_REQUIRED");

  // 2. Invalid reason rejected by schema.
  assertError(
    "invalid reason",
    await request<ErrorBody>(endpoint, "/api/abuse-reports", { method: "POST", headers: authHeaders(reporterAuth.apiKey), body: JSON.stringify({ targetAgent: target, reason: "nonsense" }) }),
    400,
    "VALIDATION_ERROR"
  );

  // 3. Unknown target.
  assertError(
    "unknown target",
    await request<ErrorBody>(endpoint, "/api/abuse-reports", { method: "POST", headers: authHeaders(reporterAuth.apiKey), body: JSON.stringify({ targetAgent: `no-such-${suffix}`, reason: "spam" }) }),
    404,
    "NOT_FOUND"
  );

  // 4. Can't report your own agent.
  assertError(
    "self report",
    await request<ErrorBody>(endpoint, "/api/abuse-reports", { method: "POST", headers: authHeaders(reporterAuth.apiKey), body: JSON.stringify({ targetAgent: own, reason: "spam" }) }),
    400,
    "VALIDATION_ERROR"
  );

  // 5. Valid report.
  const filed = await request<{ reportId?: string; status?: string }>(endpoint, "/api/abuse-reports", {
    method: "POST",
    headers: authHeaders(reporterAuth.apiKey),
    body: valid,
  });
  assertStatus("file report", filed.status, 201);
  const reportId = filed.body.reportId;
  if (!reportId || filed.body.status !== "open") throw new Error("file: missing reportId or not open");

  // 6. Duplicate open report from the same reporter.
  assertError(
    "duplicate report",
    await request<ErrorBody>(endpoint, "/api/abuse-reports", { method: "POST", headers: authHeaders(reporterAuth.apiKey), body: JSON.stringify({ targetAgent: target, reason: "scam" }) }),
    409,
    "CONFLICT"
  );

  // 7. Moderation queue (open in dev) lists the report.
  const queue = await request<{ reports: { reportId: string }[] }>(endpoint, "/api/abuse-reports?status=open");
  assertStatus("queue", queue.status, 200);
  if (!queue.body.reports.some((r) => r.reportId === reportId)) throw new Error("queue: report missing");

  // 8. Bad limit doesn't 500.
  assertStatus("queue bad limit", (await request(endpoint, "/api/abuse-reports?limit=abc")).status, 200);

  // 9. Resolve it.
  const resolved = await request<{ status?: string }>(endpoint, `/api/abuse-reports/${reportId}/resolve`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ status: "resolved", resolution: "warned + restitution" }),
  });
  assertStatus("resolve", resolved.status, 200);
  if (resolved.body.status !== "resolved") throw new Error("resolve: status not resolved");

  // 10. Fee policy is public and charges no platform fee.
  const policy = await request<{ peerToPeer?: { platformFeeBps?: number } }>(endpoint, "/api/fee-policy");
  assertStatus("fee policy", policy.status, 200);
  if (policy.body.peerToPeer?.platformFeeBps !== 0) throw new Error("fee policy: expected 0 platform fee");

  console.log("✓ abuse contract: auth → validation → self/duplicate guards → queue → resolve → fee policy");
}

main().catch((err) => {
  console.error("✗ abuse contract failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
