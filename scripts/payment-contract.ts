import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AxonClient } from "../src/sdk";
import { buildPaymentHeader, decodeRequirements } from "../src/lib/x402";

type Json = Record<string, unknown>;

interface HttpResult<T = Json> {
  status: number;
  body: T;
  headers: Headers;
}

interface ErrorBody {
  error?: string;
  code?: string;
}

interface TaskBody {
  taskId: string;
  status: string;
  payment?: string;
}

interface ChannelBody {
  channel: {
    channelId: string;
    ownerAddress: string;
    balanceUsdc: number;
    status: string;
  };
  channelKey: string;
}

const RECEIVER = process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ?? "";

function signChallenge(keypair: Keypair, challenge: string): string {
  const message = new TextEncoder().encode(challenge);
  const signature = nacl.sign.detached(message, keypair.secretKey);
  return Buffer.from(signature).toString("base64");
}

function mockSignature(opts: {
  signer: string;
  receiver?: string;
  units: bigint | number;
  currency?: "USDC" | "SOL";
  nonce?: string;
}): string {
  return [
    "mockpay",
    opts.currency ?? "USDC",
    String(opts.units),
    opts.signer,
    opts.receiver ?? RECEIVER,
    opts.nonce ?? `${Date.now()}-${Math.random()}`,
  ].join(":");
}

async function request<T = Json>(
  endpoint: string,
  path: string,
  init?: RequestInit
): Promise<HttpResult<T>> {
  const res = await fetch(`${endpoint}${path}`, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) as T : {} as T;
  return { status: res.status, body, headers: res.headers };
}

function authHeaders(apiKey?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
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

function assertStatus(label: string, actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${actual}`);
  }
}

function assertError(label: string, result: HttpResult<ErrorBody>, expectedStatus: number, expectedCode: string) {
  assertStatus(label, result.status, expectedStatus);
  if (result.body.code !== expectedCode) {
    throw new Error(`${label}: expected error code ${expectedCode}, got ${String(result.body.code)}`);
  }
  if (typeof result.body.error !== "string" || !result.body.error) {
    throw new Error(`${label}: expected a human-readable error`);
  }
}

function assertApprox(label: string, actual: number, expected: number) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function main() {
  if (process.env.AXON_PAYMENT_VERIFIER !== "mock") {
    throw new Error("payment contract requires AXON_PAYMENT_VERIFIER=mock");
  }
  if (!RECEIVER) {
    throw new Error("payment contract requires NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS");
  }

  const endpoint = process.env.AXON_CONTRACT_ENDPOINT ?? "http://localhost:3000";
  const suffix = Date.now();
  const ownerWallet = Keypair.generate();
  const payerWallet = Keypair.generate();
  const agentKeys = Keypair.generate();
  const ownerAddress = ownerWallet.publicKey.toBase58();
  const payerAddress = payerWallet.publicKey.toBase58();
  const agentId = `smoke-agent-payment-${suffix}`;

  const ownerAuth = await login(endpoint, ownerWallet);

  const register = await request(endpoint, "/api/agents", {
    method: "POST",
    headers: authHeaders(ownerAuth.apiKey),
    body: JSON.stringify({
      agentId,
      name: "Payment Contract Agent",
      capabilities: ["testing", "local-smoke", `payment-${suffix}`],
      publicKey: Buffer.from(agentKeys.publicKey.toBytes()).toString("base64"),
      walletAddress: ownerAddress,
      price: "0.10 USDC",
    }),
  });
  assertStatus("register paid agent", register.status, 201);

  const requirementsRes = await request(endpoint, `/api/agents/${agentId}/x402`);
  assertStatus("x402 requirements", requirementsRes.status, 402);
  const rawReq = requirementsRes.headers.get("x-payment-required");
  if (!rawReq) throw new Error("x402 requirements: missing X-Payment-Required header");
  const requirements = decodeRequirements(rawReq);
  if (!requirements) throw new Error("x402 requirements: could not decode requirements");
  if (requirements.accepts[0]?.payToAddress !== RECEIVER) {
    throw new Error("x402 requirements: wrong receiver wallet");
  }
  if (requirements.accepts[0]?.maxAmountRequired !== "100000") {
    throw new Error("x402 requirements: expected 100000 micro-USDC");
  }

  const directSig = mockSignature({ signer: payerAddress, units: 100_000, nonce: `direct-ok-${suffix}` });
  const directPaidTask = await request<TaskBody>(endpoint, "/api/tasks", {
    method: "POST",
    headers: { ...authHeaders(), "Idempotency-Key": `paid-direct-${suffix}` },
    body: JSON.stringify({
      from: payerAddress,
      to: agentId,
      task: "Paid direct contract task",
      paymentSignature: directSig,
    }),
  });
  assertStatus("direct paid task creates task", directPaidTask.status, 201);

  const directPaidReplay = await request<TaskBody>(endpoint, "/api/tasks", {
    method: "POST",
    headers: { ...authHeaders(), "Idempotency-Key": `paid-direct-${suffix}` },
    body: JSON.stringify({
      from: payerAddress,
      to: agentId,
      task: "Paid direct contract task",
      paymentSignature: directSig,
    }),
  });
  assertStatus("direct paid task idempotent replay", directPaidReplay.status, 200);
  if (directPaidReplay.body.taskId !== directPaidTask.body.taskId) {
    throw new Error("direct paid task idempotent replay returned a different task");
  }

  const directPaidSignatureReplay = await request<TaskBody>(endpoint, "/api/tasks", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      from: payerAddress,
      to: agentId,
      task: "Paid direct contract task",
      paymentSignature: directSig,
    }),
  });
  assertStatus("direct paid task payment-signature replay", directPaidSignatureReplay.status, 200);
  if (directPaidSignatureReplay.body.taskId !== directPaidTask.body.taskId) {
    throw new Error("direct paid task payment-signature replay returned a different task");
  }

  const directPaidConflict = await request<ErrorBody>(endpoint, "/api/tasks", {
    method: "POST",
    headers: { ...authHeaders(), "Idempotency-Key": `paid-direct-${suffix}` },
    body: JSON.stringify({
      from: payerAddress,
      to: agentId,
      task: "Different direct paid task",
      paymentSignature: directSig,
    }),
  });
  assertError("direct paid task idempotency conflict", directPaidConflict, 409, "CONFLICT");

  const validSig = mockSignature({ signer: payerAddress, units: 100_000, nonce: `x402-ok-${suffix}` });
  const validPayment = buildPaymentHeader(validSig, payerAddress, requirements.accepts[0].network);
  const paidTask = await request<TaskBody>(endpoint, `/api/agents/${agentId}/x402`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": validPayment },
    body: JSON.stringify({ task: "Paid x402 contract task" }),
  });
  assertStatus("valid x402 payment creates task", paidTask.status, 201);
  if (paidTask.body.status !== "queued" || paidTask.body.payment !== "0.10 USDC") {
    throw new Error(`valid x402 payment: unexpected task state ${JSON.stringify(paidTask.body)}`);
  }

  const replay = await request<ErrorBody>(endpoint, `/api/agents/${agentId}/x402`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": validPayment },
    body: JSON.stringify({ task: "Replay should fail" }),
  });
  assertError("x402 replay is rejected", replay, 402, "PAYMENT_FAILED");

  const wrongAmountSig = mockSignature({ signer: payerAddress, units: 99_999, nonce: `x402-low-${suffix}` });
  const wrongAmount = await request<ErrorBody>(endpoint, `/api/agents/${agentId}/x402`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": buildPaymentHeader(wrongAmountSig, payerAddress, requirements.accepts[0].network) },
    body: JSON.stringify({ task: "Wrong amount should fail" }),
  });
  assertError("x402 wrong amount is rejected", wrongAmount, 402, "PAYMENT_FAILED");

  const otherSigner = Keypair.generate().publicKey.toBase58();
  const wrongSignerSig = mockSignature({ signer: otherSigner, units: 100_000, nonce: `x402-signer-${suffix}` });
  const wrongSigner = await request<ErrorBody>(endpoint, `/api/agents/${agentId}/x402`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": buildPaymentHeader(wrongSignerSig, payerAddress, requirements.accepts[0].network) },
    body: JSON.stringify({ task: "Wrong signer should fail" }),
  });
  assertError("x402 wrong signer is rejected", wrongSigner, 402, "PAYMENT_FAILED");

  const wrongReceiverSig = mockSignature({
    signer: payerAddress,
    receiver: Keypair.generate().publicKey.toBase58(),
    units: 100_000,
    nonce: `x402-receiver-${suffix}`,
  });
  const wrongReceiver = await request<ErrorBody>(endpoint, `/api/agents/${agentId}/x402`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": buildPaymentHeader(wrongReceiverSig, payerAddress, requirements.accepts[0].network) },
    body: JSON.stringify({ task: "Wrong receiver should fail" }),
  });
  assertError("x402 wrong receiver is rejected", wrongReceiver, 402, "PAYMENT_FAILED");

  const openChannel = await request<ChannelBody>(endpoint, "/api/mpp/channels", {
    method: "POST",
    headers: authHeaders(ownerAuth.apiKey),
    body: JSON.stringify({
      ownerAddress,
      depositUsdc: "0.25",
      depositSignature: mockSignature({ signer: ownerAddress, units: 250_000, nonce: `mpp-open-${suffix}` }),
    }),
  });
  assertStatus("MPP channel opens with verified deposit", openChannel.status, 201);
  assertApprox("MPP opening balance", openChannel.body.channel.balanceUsdc, 0.25);

  const mppTask = await request<TaskBody>(endpoint, `/api/agents/${agentId}/x402`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MPP-Channel": openChannel.body.channel.channelId,
      Authorization: `Bearer ${openChannel.body.channelKey}`,
    },
    body: JSON.stringify({ task: "MPP paid contract task" }),
  });
  assertStatus("MPP debit creates task", mppTask.status, 201);

  const afterDebit = await request<{ channel: { balanceUsdc: number } }>(
    endpoint,
    `/api/mpp/channels/${openChannel.body.channel.channelId}`,
    { headers: { Authorization: `Bearer ${openChannel.body.channelKey}` } }
  );
  assertStatus("MPP channel readable after debit", afterDebit.status, 200);
  assertApprox("MPP balance after debit", afterDebit.body.channel.balanceUsdc, 0.15);

  const topupSig = mockSignature({ signer: ownerAddress, units: 50_000, nonce: `mpp-topup-${suffix}` });
  const topup = await request<{ channel: { balanceUsdc: number } }>(
    endpoint,
    `/api/mpp/channels/${openChannel.body.channel.channelId}/topup`,
    {
      method: "POST",
      headers: authHeaders(openChannel.body.channelKey),
      body: JSON.stringify({ depositUsdc: "0.05", depositSignature: topupSig }),
    }
  );
  assertStatus("MPP top-up succeeds", topup.status, 200);
  assertApprox("MPP balance after top-up", topup.body.channel.balanceUsdc, 0.2);

  const replayTopup = await request<ErrorBody>(
    endpoint,
    `/api/mpp/channels/${openChannel.body.channel.channelId}/topup`,
    {
      method: "POST",
      headers: authHeaders(openChannel.body.channelKey),
      body: JSON.stringify({ depositUsdc: "0.05", depositSignature: topupSig }),
    }
  );
  assertError("MPP deposit replay is rejected", replayTopup, 402, "PAYMENT_FAILED");

  const spendSecond = await request<TaskBody>(endpoint, `/api/agents/${agentId}/x402`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MPP-Channel": openChannel.body.channel.channelId,
      Authorization: `Bearer ${openChannel.body.channelKey}`,
    },
    body: JSON.stringify({ task: "MPP second task" }),
  });
  assertStatus("MPP second debit succeeds", spendSecond.status, 201);

  const spendThird = await request<TaskBody>(endpoint, `/api/agents/${agentId}/x402`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MPP-Channel": openChannel.body.channel.channelId,
      Authorization: `Bearer ${openChannel.body.channelKey}`,
    },
    body: JSON.stringify({ task: "MPP third task" }),
  });
  assertStatus("MPP third debit succeeds", spendThird.status, 201);

  const insufficient = await request<ErrorBody>(endpoint, `/api/agents/${agentId}/x402`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MPP-Channel": openChannel.body.channel.channelId,
      Authorization: `Bearer ${openChannel.body.channelKey}`,
    },
    body: JSON.stringify({ task: "MPP should be out of balance" }),
  });
  assertError("MPP insufficient balance is rejected", insufficient, 402, "PAYMENT_FAILED");

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    agentId,
    paidTaskId: paidTask.body.taskId,
    mppTaskId: mppTask.body.taskId,
    channelId: openChannel.body.channel.channelId,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
