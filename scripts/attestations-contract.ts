// End-to-end contract test for capability attestations (Phase 8).
// Run against a running server: `npm run contract:attestations`
// (set AXON_CONTRACT_ENDPOINT, defaults to http://localhost:3000).
//
// Covers the HTTP contract: signature-as-auth (no API key), the capability /
// self-attestation / duplicate guards, and the full attest → list → revoke flow
// — including the DELETE-with-body revoke path over real HTTP. The signature
// math is unit-tested.

import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AxonClient } from "../src/sdk";

type Json = Record<string, unknown>;
interface ErrorBody { error?: string; code?: string }

function sign(keypair: Keypair, message: string): string {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)).toString("base64");
}
const attestMsg = (agentId: string, capability: string) => `axon-attest:${agentId}:${capability}`;
const revokeMsg = (attestationId: string) => `axon-attest-revoke:${attestationId}`;

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
  return client.verifyAuthChallenge({ walletAddress, challenge, signature: sign(keypair, challenge) });
}

async function registerAgent(endpoint: string, apiKey: string, agentId: string, wallet: string, keys: Keypair, capabilities: string[]) {
  assertStatus(
    `register ${agentId}`,
    (await request(endpoint, "/api/agents", {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        agentId,
        name: agentId,
        capabilities,
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

  const ownerWallet = Keypair.generate(); // the agent's owner wallet
  const verifierWallet = Keypair.generate(); // an independent third-party verifier
  const ownerAddr = ownerWallet.publicKey.toBase58();
  const verifierAddr = verifierWallet.publicKey.toBase58();
  const agentId = `att-${suffix}`;
  const cap = "research";

  const ownerAuth = await login(endpoint, ownerWallet);
  await registerAgent(endpoint, ownerAuth.apiKey, agentId, ownerAddr, Keypair.generate(), [cap]);

  const path = `/api/agents/${agentId}/attestations`;

  // 1. A signature that doesn't match the claimed verifier is rejected.
  assertError(
    "bad signature",
    await request<ErrorBody>(endpoint, path, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ capability: cap, verifier: verifierAddr, signature: sign(Keypair.generate(), attestMsg(agentId, cap)) }),
    }),
    400,
    "VALIDATION_ERROR"
  );

  // 2. Can't attest a capability the agent doesn't list.
  assertError(
    "capability not listed",
    await request<ErrorBody>(endpoint, path, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ capability: "coding", verifier: verifierAddr, signature: sign(verifierWallet, attestMsg(agentId, "coding")) }),
    }),
    400,
    "VALIDATION_ERROR"
  );

  // 3. Unknown agent.
  const ghost = `no-such-agent-${suffix}`;
  assertError(
    "unknown agent",
    await request<ErrorBody>(endpoint, `/api/agents/${ghost}/attestations`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ capability: cap, verifier: verifierAddr, signature: sign(verifierWallet, attestMsg(ghost, cap)) }),
    }),
    404,
    "NOT_FOUND"
  );

  // 4. An owner can't attest its own agent.
  assertError(
    "self-attestation",
    await request<ErrorBody>(endpoint, path, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ capability: cap, verifier: ownerAddr, signature: sign(ownerWallet, attestMsg(agentId, cap)) }),
    }),
    403,
    "FORBIDDEN"
  );

  // 5. A validly-signed attestation is accepted — no API key required.
  const created = await request<{ attestationId?: string }>(endpoint, path, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ capability: cap, verifier: verifierAddr, signature: sign(verifierWallet, attestMsg(agentId, cap)) }),
  });
  assertStatus("create attestation", created.status, 201);
  const attestationId = created.body.attestationId;
  if (!attestationId) throw new Error("create: missing attestationId");

  // 6. It shows up in the public list.
  const list = await request<{ attestations: { attestationId: string }[] }>(endpoint, path);
  assertStatus("list attestations", list.status, 200);
  if (!list.body.attestations.some((a) => a.attestationId === attestationId)) {
    throw new Error("list: created attestation missing");
  }

  // 7. The same verifier can't attest the same capability twice.
  assertError(
    "duplicate attestation",
    await request<ErrorBody>(endpoint, path, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ capability: cap, verifier: verifierAddr, signature: sign(verifierWallet, attestMsg(agentId, cap)) }),
    }),
    409,
    "CONFLICT"
  );

  // 8. Revoke needs the verifier's own signature.
  assertError(
    "revoke with wrong signature",
    await request<ErrorBody>(endpoint, `${path}/${attestationId}`, {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({ signature: sign(Keypair.generate(), revokeMsg(attestationId)) }),
    }),
    400,
    "VALIDATION_ERROR"
  );

  // 9. Revoking an unknown attestation.
  assertError(
    "revoke unknown",
    await request<ErrorBody>(endpoint, `${path}/no-such-${suffix}`, {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({ signature: sign(verifierWallet, revokeMsg(`no-such-${suffix}`)) }),
    }),
    404,
    "NOT_FOUND"
  );

  // 10. The verifier revokes (DELETE-with-body over real HTTP).
  assertStatus(
    "revoke attestation",
    (await request(endpoint, `${path}/${attestationId}`, {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({ signature: sign(verifierWallet, revokeMsg(attestationId)) }),
    })).status,
    200
  );

  // 11. It's gone.
  const after = await request<{ attestations: { attestationId: string }[] }>(endpoint, path);
  if (after.body.attestations.some((a) => a.attestationId === attestationId)) {
    throw new Error("revoke: attestation still listed after revocation");
  }

  console.log("✓ attestations contract: signature-auth → capability/self/duplicate guards → attest → list → revoke");
}

main().catch((err) => {
  console.error("✗ attestations contract failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
