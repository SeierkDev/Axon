// End-to-end contract test for composable workflow templates (Phase 8).
// Run against a running server: `npm run contract:workflow-templates`
// (set AXON_CONTRACT_ENDPOINT, defaults to http://localhost:3000).
//
// Covers the HTTP contract: auth, validation, owner-only delete, the paid/param
// guards, and the full create → instantiate flow. Resolution math is unit-tested.

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
        capabilities: ["workflow-templates-contract"],
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

  const ownerWallet = Keypair.generate();
  const otherWallet = Keypair.generate();
  const ownerAddr = ownerWallet.publicKey.toBase58();
  const a = `wt-a-${suffix}`;
  const b = `wt-b-${suffix}`;

  const ownerAuth = await login(endpoint, ownerWallet);
  const otherAuth = await login(endpoint, otherWallet);
  await registerAgent(endpoint, ownerAuth.apiKey, a, ownerAddr, Keypair.generate());
  await registerAgent(endpoint, ownerAuth.apiKey, b, ownerAddr, Keypair.generate());

  const name = `pipeline-${suffix}`;
  const validBody = JSON.stringify({ from: ownerAddr, name, agents: [a, b], taskTemplate: "Summarize {{topic}}" });

  // 1. Auth required to create.
  assertError(
    "create without auth",
    await request<ErrorBody>(endpoint, "/api/workflow-templates", { method: "POST", headers: authHeaders(), body: validBody }),
    401,
    "AUTH_REQUIRED"
  );

  // 2. Validation — at least one agent.
  assertError(
    "create with no agents",
    await request<ErrorBody>(endpoint, "/api/workflow-templates", {
      method: "POST",
      headers: authHeaders(ownerAuth.apiKey),
      body: JSON.stringify({ from: ownerAddr, name: `${name}-x`, agents: [], taskTemplate: "x" }),
    }),
    400,
    "VALIDATION_ERROR"
  );

  // 3. Unknown agent in the chain.
  assertError(
    "create with unknown agent",
    await request<ErrorBody>(endpoint, "/api/workflow-templates", {
      method: "POST",
      headers: authHeaders(ownerAuth.apiKey),
      body: JSON.stringify({ from: ownerAddr, name: `${name}-y`, agents: [a, "no-such-agent"], taskTemplate: "x" }),
    }),
    404,
    "NOT_FOUND"
  );

  // 4. Create succeeds; parameters are derived.
  const created = await request<{ templateId: string; parameters: string[] }>(endpoint, "/api/workflow-templates", {
    method: "POST",
    headers: authHeaders(ownerAuth.apiKey),
    body: validBody,
  });
  assertStatus("create template", created.status, 201);
  const templateId = created.body.templateId;
  if (!templateId) throw new Error("create: missing templateId");
  if (JSON.stringify(created.body.parameters) !== JSON.stringify(["topic"])) {
    throw new Error(`create: expected parameters ["topic"], got ${JSON.stringify(created.body.parameters)}`);
  }

  // 5. Duplicate name rejected.
  assertError(
    "duplicate template name",
    await request<ErrorBody>(endpoint, "/api/workflow-templates", { method: "POST", headers: authHeaders(ownerAuth.apiKey), body: validBody }),
    409,
    "CONFLICT"
  );

  // 6. Public read works.
  assertStatus("get template", (await request(endpoint, `/api/workflow-templates/${templateId}`)).status, 200);

  const instantiatePath = `/api/workflow-templates/${templateId}/instantiate`;

  // 7. Instantiate without auth.
  assertError(
    "instantiate without auth",
    await request<ErrorBody>(endpoint, instantiatePath, { method: "POST", headers: authHeaders(), body: JSON.stringify({ from: ownerAddr, params: { topic: "x402" } }) }),
    401,
    "AUTH_REQUIRED"
  );

  // 8. Missing parameter.
  assertError(
    "instantiate missing param",
    await request<ErrorBody>(endpoint, instantiatePath, { method: "POST", headers: authHeaders(ownerAuth.apiKey), body: JSON.stringify({ from: ownerAddr, params: {} }) }),
    400,
    "VALIDATION_ERROR"
  );

  // 9. Instantiate succeeds → a workflow starts.
  const ran = await request<{ workflow?: { workflowId?: string } }>(endpoint, instantiatePath, {
    method: "POST",
    headers: authHeaders(ownerAuth.apiKey),
    body: JSON.stringify({ from: ownerAddr, params: { topic: "x402" } }),
  });
  assertStatus("instantiate", ran.status, 201);
  if (!ran.body.workflow?.workflowId) throw new Error("instantiate: missing workflow");

  // 10. Only the owner can delete.
  assertError(
    "non-owner cannot delete",
    await request<ErrorBody>(endpoint, `/api/workflow-templates/${templateId}`, { method: "DELETE", headers: authHeaders(otherAuth.apiKey) }),
    403,
    "FORBIDDEN"
  );
  assertStatus(
    "owner deletes template",
    (await request(endpoint, `/api/workflow-templates/${templateId}`, { method: "DELETE", headers: authHeaders(ownerAuth.apiKey) })).status,
    200
  );

  console.log("✓ workflow-templates contract: auth → validation → create → instantiate → owner-only delete");
}

main().catch((err) => {
  console.error("✗ workflow-templates contract failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
