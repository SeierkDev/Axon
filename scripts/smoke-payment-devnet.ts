// Live devnet payment smoke test.
//
// Sends a real SOL transaction on Solana devnet and verifies that Axon's
// on-chain payment verifier accepts it. This is the one test that cannot
// be faked with AXON_PAYMENT_VERIFIER=mock.
//
// Prerequisites:
//   - App running at AXON_SMOKE_ENDPOINT (default http://localhost:3000)
//   - AXON_PAYMENT_VERIFIER must NOT be set to "mock"
//   - SOLANA_NETWORK=devnet
//   - HELIUS_API_KEY set (used for devnet RPC)
//   - NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS set to a real wallet
//   - An API key available (AXON_SMOKE_API_KEY or auto-obtained via challenge)
//
// What it does:
//   1. Validates prerequisites
//   2. Generates a fresh payer keypair
//   3. Airdrops 0.05 SOL from the devnet faucet
//   4. Registers a test agent with price "0.001 SOL"
//   5. Transfers 0.001 SOL on-chain to the payment receiver
//   6. Submits the task to Axon with the real transaction signature
//   7. Verifies the task is accepted (not rejected as PAYMENT_FAILED)
//   8. Reports latency and success
//
// Run:
//   SOLANA_NETWORK=devnet npm run smoke:devnet-payment

import nacl from "tweetnacl";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

// ── Config ────────────────────────────────────────────────────────────────────

const ENDPOINT      = process.env.AXON_SMOKE_ENDPOINT ?? "http://localhost:3000";
const NETWORK       = process.env.SOLANA_NETWORK ?? "devnet";
const HELIUS_KEY    = process.env.HELIUS_API_KEY ?? "";
const RECEIVER      = process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS
                   ?? process.env.NEXT_PUBLIC_WALLET_ADDRESS
                   ?? "";
const EXISTING_KEY  = process.env.AXON_SMOKE_API_KEY ?? "";

// Amount for the test — small enough to be negligible, large enough to pass min checks
const PAYMENT_SOL  = 0.001;
const AIRDROP_SOL  = 0.05;
const AGENT_PRICE  = `${PAYMENT_SOL} SOL`;

// ── RPC connection ────────────────────────────────────────────────────────────

function getRpcUrl(): string {
  if (HELIUS_KEY) {
    return `https://${NETWORK}.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  }
  // Fall back to public devnet endpoint (rate-limited, fine for one test)
  return "https://api.devnet.solana.com";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function jsonFetch<T>(
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) as T : {} as T;
  return { status: res.status, body };
}

function signChallenge(keypair: Keypair, challenge: string): string {
  const msg = new TextEncoder().encode(challenge);
  const sig = nacl.sign.detached(msg, keypair.secretKey);
  return Buffer.from(sig).toString("base64");
}

async function getApiKey(authWallet: Keypair): Promise<string> {
  if (EXISTING_KEY) return EXISTING_KEY;

  const walletAddress = authWallet.publicKey.toBase58();
  const { body: c } = await jsonFetch<{ challenge: string }>(
    "/api/auth/challenge",
    {
      method: "POST",
      body: JSON.stringify({ walletAddress }),
    }
  );
  if (!c.challenge) throw new Error("Challenge endpoint did not return a challenge");

  const { status, body: v } = await jsonFetch<{ apiKey: string }>(
    "/api/auth/verify",
    {
      method: "POST",
      body: JSON.stringify({
        walletAddress,
        challenge: c.challenge,
        signature: signChallenge(authWallet, c.challenge),
      }),
    }
  );
  if (status !== 200 || !v.apiKey) throw new Error(`Auth failed (HTTP ${status})`);
  return v.apiKey;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Prerequisites
  if (NETWORK !== "devnet") {
    throw new Error(
      `SOLANA_NETWORK must be "devnet" for this test. Got: "${NETWORK}". ` +
      "Do not run live payment tests against mainnet."
    );
  }
  if (!RECEIVER) {
    throw new Error("NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS is required");
  }
  if (process.env.AXON_PAYMENT_VERIFIER === "mock") {
    throw new Error(
      "AXON_PAYMENT_VERIFIER=mock is set — this test requires real on-chain verification. " +
      "Unset AXON_PAYMENT_VERIFIER to run against devnet."
    );
  }

  console.log(`\n[devnet] Running live payment smoke test`);
  console.log(`  endpoint : ${ENDPOINT}`);
  console.log(`  network  : ${NETWORK}`);
  console.log(`  receiver : ${RECEIVER}`);
  console.log();

  const connection = new Connection(getRpcUrl(), "confirmed");

  // 2. Generate test wallets
  const authWallet = Keypair.generate();
  const payerWallet = Keypair.generate();
  const payerAddress = payerWallet.publicKey.toBase58();
  const agentId = `devnet-smoke-${Date.now()}`;
  const suffix = Date.now();

  console.log(`[1/7] Payer wallet: ${payerAddress}`);

  // 3. Airdrop devnet SOL to the payer
  console.log(`[2/7] Requesting ${AIRDROP_SOL} SOL airdrop on devnet…`);
  const airdropSig = await connection.requestAirdrop(
    payerWallet.publicKey,
    AIRDROP_SOL * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(airdropSig, "confirmed");
  const balance = await connection.getBalance(payerWallet.publicKey);
  console.log(`      Balance confirmed: ${balance / LAMPORTS_PER_SOL} SOL`);

  // 4. Authenticate with the app
  console.log(`[3/7] Authenticating with Axon API…`);
  const apiKey = await getApiKey(authWallet);
  console.log(`      API key obtained`);

  // 5. Register a temporary test agent with SOL price
  console.log(`[4/7] Registering test agent ${agentId} (price: ${AGENT_PRICE})…`);
  const { status: regStatus, body: regBody } = await jsonFetch<{ agentId?: string; error?: string }>(
    "/api/agents",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        agentId,
        name: "Devnet Smoke Agent",
        capabilities: ["devnet-smoke", `run-${suffix}`],
        publicKey: authWallet.publicKey.toBase58(),
        walletAddress: authWallet.publicKey.toBase58(),
        price: AGENT_PRICE,
      }),
    }
  );
  if (regStatus !== 201) {
    throw new Error(`Agent registration failed (HTTP ${regStatus}): ${JSON.stringify(regBody)}`);
  }
  console.log(`      Registered: ${regBody.agentId}`);

  // 6. Send real SOL payment on devnet
  console.log(`[5/7] Sending ${PAYMENT_SOL} SOL from payer → receiver on devnet…`);
  const t0 = Date.now();

  const receiverPk = new PublicKey(RECEIVER);
  const transferTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payerWallet.publicKey,
      toPubkey: receiverPk,
      lamports: Math.round(PAYMENT_SOL * LAMPORTS_PER_SOL),
    })
  );

  const txSignature = await sendAndConfirmTransaction(
    connection,
    transferTx,
    [payerWallet],
    { commitment: "confirmed" }
  );

  const paymentLatencyMs = Date.now() - t0;
  console.log(`      Confirmed in ${paymentLatencyMs}ms`);
  console.log(`      Signature: ${txSignature}`);

  // 7. Small delay to let Helius index the transaction
  await sleep(2000);

  // 8. Submit task with real signature
  console.log(`[6/7] Submitting task with on-chain signature…`);
  const t1 = Date.now();
  const { status: taskStatus, body: taskBody } = await jsonFetch<{
    taskId?: string;
    status?: string;
    error?: string;
    code?: string;
    message?: string;
  }>("/api/tasks", {
    method: "POST",
    headers: { "Idempotency-Key": `devnet-smoke-${suffix}` },
    body: JSON.stringify({
      from: payerAddress,
      to: agentId,
      task: "Devnet live payment smoke test",
      paymentSignature: txSignature,
    }),
  });

  const taskLatencyMs = Date.now() - t1;

  if (taskStatus === 402) {
    throw new Error(
      `Payment rejected by Axon (HTTP 402). ` +
      `Code: ${String(taskBody.code ?? "unknown")} — ${String(taskBody.message ?? taskBody.error ?? "")}. ` +
      `Signature: ${txSignature}`
    );
  }
  if (taskStatus !== 201) {
    throw new Error(`Task submission failed (HTTP ${taskStatus}): ${JSON.stringify(taskBody)}`);
  }

  console.log(`      Accepted in ${taskLatencyMs}ms — taskId: ${taskBody.taskId}`);

  // 9. Verify task is in a live state
  const { status: getStatus, body: getBody } = await jsonFetch<{
    status?: string;
    payment?: string;
  }>(`/api/tasks/${taskBody.taskId}`);

  if (getStatus !== 200) {
    throw new Error(`Could not fetch task (HTTP ${getStatus})`);
  }
  if (!["queued", "running", "completed"].includes(getBody.status ?? "")) {
    throw new Error(`Task in unexpected state: ${getBody.status}`);
  }

  console.log(`[7/7] Task state: ${getBody.status}`);

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log();
  console.log(JSON.stringify({
    ok: true,
    network: NETWORK,
    endpoint: ENDPOINT,
    agentId,
    payerAddress,
    txSignature,
    taskId: taskBody.taskId,
    taskStatus: getBody.status,
    paymentLatencyMs,
    taskLatencyMs,
  }, null, 2));
}

main().catch((err: unknown) => {
  console.error("\n[devnet] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
