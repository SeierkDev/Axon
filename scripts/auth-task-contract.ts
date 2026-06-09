import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AxonApiError, AxonClient } from "../src/sdk";

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
  const message = new TextEncoder().encode(challenge);
  const signature = nacl.sign.detached(message, keypair.secretKey);
  return Buffer.from(signature).toString("base64");
}

async function request<T = Json>(
  endpoint: string,
  path: string,
  init?: RequestInit
): Promise<HttpResult<T>> {
  const res = await fetch(`${endpoint}${path}`, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) as T : {} as T;
  return { status: res.status, body };
}

function assertStatus(label: string, actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${actual}`);
  }
}

function assertError(
  label: string,
  result: HttpResult<ErrorBody>,
  expectedStatus: number,
  expectedCode: string
) {
  assertStatus(label, result.status, expectedStatus);
  if (result.body.code !== expectedCode) {
    throw new Error(`${label}: expected error code ${expectedCode}, got ${String(result.body.code)}`);
  }
  if (typeof result.body.error !== "string" || !result.body.error) {
    throw new Error(`${label}: expected a human-readable error message`);
  }
}

async function assertSdkError(
  label: string,
  action: () => Promise<unknown>,
  expectedStatus: number,
  expectedCode: string
) {
  try {
    await action();
  } catch (err) {
    if (!(err instanceof AxonApiError)) {
      throw new Error(`${label}: expected AxonApiError, got ${err instanceof Error ? err.name : typeof err}`);
    }
    if (err.status !== expectedStatus) {
      throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${err.status}`);
    }
    if (err.code !== expectedCode) {
      throw new Error(`${label}: expected error code ${expectedCode}, got ${String(err.code)}`);
    }
    if (!err.message) {
      throw new Error(`${label}: expected a human-readable error message`);
    }
    return;
  }

  throw new Error(`${label}: expected request to fail`);
}

async function login(endpoint: string, keypair: Keypair) {
  const walletAddress = keypair.publicKey.toBase58();
  const client = new AxonClient();
  client.init({ endpoint });
  const { challenge } = await client.createAuthChallenge(walletAddress);
  return client.verifyAuthChallenge({
    walletAddress,
    challenge,
    signature: signChallenge(keypair, challenge),
  });
}

function authHeaders(apiKey?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function main() {
  const endpoint = process.env.AXON_CONTRACT_ENDPOINT ?? "http://localhost:3000";
  const suffix = Date.now();

  const ownerWallet = Keypair.generate();
  const otherWallet = Keypair.generate();
  const agentKeys = Keypair.generate();
  const ownerAddress = ownerWallet.publicKey.toBase58();
  const agentId = `smoke-agent-contract-${suffix}`;

  const ownerAuth = await login(endpoint, ownerWallet);
  const otherAuth = await login(endpoint, otherWallet);
  const unauthenticatedClient = new AxonClient();
  unauthenticatedClient.init({ endpoint });

  const agentPayload = {
    agentId,
    name: "Contract Test Agent",
    capabilities: ["testing", "local-smoke", `contract-${suffix}`],
    publicKey: Buffer.from(agentKeys.publicKey.toBytes()).toString("base64"),
    walletAddress: ownerAddress,
  };

  assertError(
    "register without API key",
    await request<ErrorBody>(endpoint, "/api/agents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(agentPayload),
    }),
    401,
    "AUTH_REQUIRED"
  );

  await assertSdkError(
    "SDK exposes structured auth error",
    () => unauthenticatedClient.register(agentPayload),
    401,
    "AUTH_REQUIRED"
  );
  await assertSdkError(
    "SDK exposes structured gateway not-found error",
    () => unauthenticatedClient.getGatewayProvider(`missing-provider-${suffix}`),
    404,
    "NOT_FOUND"
  );
  await assertSdkError(
    "SDK exposes structured x402 not-found error",
    () => unauthenticatedClient.getX402Requirements(`missing-agent-${suffix}`),
    404,
    "NOT_FOUND"
  );

  assertError(
    "register with wrong wallet owner",
    await request<ErrorBody>(endpoint, "/api/agents", {
      method: "POST",
      headers: authHeaders(otherAuth.apiKey),
      body: JSON.stringify(agentPayload),
    }),
    403,
    "FORBIDDEN"
  );

  assertStatus(
    "owner registers agent",
    (await request(endpoint, "/api/agents", {
      method: "POST",
      headers: authHeaders(ownerAuth.apiKey),
      body: JSON.stringify(agentPayload),
    })).status,
    201
  );

  assertStatus(
    "owner configures budget",
    (await request(endpoint, `/api/agents/${agentId}/budget`, {
      method: "POST",
      headers: authHeaders(ownerAuth.apiKey),
      body: JSON.stringify({
        name: "Contract budget",
        maxPerCallUsdc: 1,
        maxPerDayUsdc: 5,
      }),
    })).status,
    201
  );

  const audit = await request<{ events: Array<{ action: string; resourceId: string; ownerAgentId?: string }> }>(
    endpoint,
    `/api/audit?agentId=${encodeURIComponent(agentId)}`,
    { headers: authHeaders(ownerAuth.apiKey) }
  );
  assertStatus("owner reads audit trail", audit.status, 200);
  const auditActions = new Set(audit.body.events.map((event) => event.action));
  if (!auditActions.has("agent.created") || !auditActions.has("budget.upserted")) {
    throw new Error(`owner audit trail missing expected actions: ${JSON.stringify([...auditActions])}`);
  }

  assertError(
    "non-owner cannot read audit trail",
    await request<ErrorBody>(
      endpoint,
      `/api/audit?agentId=${encodeURIComponent(agentId)}`,
      { headers: authHeaders(otherAuth.apiKey) }
    ),
    403,
    "FORBIDDEN"
  );

  const anonymousTask = await request<{ taskId: string }>(endpoint, "/api/tasks", {
    method: "POST",
    headers: { ...authHeaders(), "Idempotency-Key": `free-anon-${suffix}` },
    body: JSON.stringify({
      from: "anonymous",
      to: agentId,
      task: "Anonymous free contract task",
      context: { cleanup: "npm run cleanup:demo", contract: true },
    }),
  });
  assertStatus("anonymous free task", anonymousTask.status, 201);

  const anonymousReplay = await request<{ taskId: string }>(endpoint, "/api/tasks", {
    method: "POST",
    headers: { ...authHeaders(), "Idempotency-Key": `free-anon-${suffix}` },
    body: JSON.stringify({
      from: "anonymous",
      to: agentId,
      task: "Anonymous free contract task",
      context: { cleanup: "npm run cleanup:demo", contract: true },
    }),
  });
  assertStatus("anonymous free task idempotent replay", anonymousReplay.status, 200);
  if (anonymousReplay.body.taskId !== anonymousTask.body.taskId) {
    throw new Error("anonymous free task idempotent replay returned a different task");
  }

  assertError(
    "idempotency key conflict",
    await request<ErrorBody>(endpoint, "/api/tasks", {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": `free-anon-${suffix}` },
      body: JSON.stringify({
        from: "anonymous",
        to: agentId,
        task: "Different task with reused key",
      }),
    }),
    409,
    "CONFLICT"
  );

  assertError(
    "attributed free task without API key",
    await request<ErrorBody>(endpoint, "/api/tasks", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        from: ownerAddress,
        to: agentId,
        task: "Should require auth",
      }),
    }),
    401,
    "AUTH_REQUIRED"
  );

  assertError(
    "attributed free task with wrong API key",
    await request<ErrorBody>(endpoint, "/api/tasks", {
      method: "POST",
      headers: authHeaders(otherAuth.apiKey),
      body: JSON.stringify({
        from: ownerAddress,
        to: agentId,
        task: "Should require matching owner",
      }),
    }),
    403,
    "FORBIDDEN"
  );

  const ownerTask = await request<{ taskId: string }>(endpoint, "/api/tasks", {
    method: "POST",
    headers: authHeaders(ownerAuth.apiKey),
    body: JSON.stringify({
      from: ownerAddress,
      to: agentId,
      task: "Owner attributed contract task",
      context: { cleanup: "npm run cleanup:demo", contract: true },
    }),
  });
  assertStatus("owner attributed free task", ownerTask.status, 201);

  assertError(
    "non-owner cannot start task",
    await request<ErrorBody>(endpoint, `/api/tasks/${ownerTask.body.taskId}/start`, {
      method: "POST",
      headers: authHeaders(otherAuth.apiKey),
      body: JSON.stringify({}),
    }),
    403,
    "FORBIDDEN"
  );

  assertStatus(
    "owner starts task",
    (await request(endpoint, `/api/tasks/${ownerTask.body.taskId}/start`, {
      method: "POST",
      headers: authHeaders(ownerAuth.apiKey),
      body: JSON.stringify({}),
    })).status,
    200
  );

  assertError(
    "non-owner cannot complete task",
    await request<ErrorBody>(endpoint, `/api/tasks/${ownerTask.body.taskId}/complete`, {
      method: "POST",
      headers: authHeaders(otherAuth.apiKey),
      body: JSON.stringify({ output: "nope" }),
    }),
    403,
    "FORBIDDEN"
  );

  assertStatus(
    "owner completes task",
    (await request(endpoint, `/api/tasks/${ownerTask.body.taskId}/complete`, {
      method: "POST",
      headers: authHeaders(ownerAuth.apiKey),
      body: JSON.stringify({ output: "contract task complete" }),
    })).status,
    200
  );

  assertError(
    "non-owner cannot read task history",
    await request<ErrorBody>(endpoint, `/api/agents/${agentId}/tasks`, {
      headers: authHeaders(otherAuth.apiKey),
    }),
    403,
    "FORBIDDEN"
  );

  assertStatus(
    "owner can read task history",
    (await request(endpoint, `/api/agents/${agentId}/tasks`, {
      headers: authHeaders(ownerAuth.apiKey),
    })).status,
    200
  );

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    agentId,
    anonymousTaskId: anonymousTask.body.taskId,
    ownerTaskId: ownerTask.body.taskId,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
