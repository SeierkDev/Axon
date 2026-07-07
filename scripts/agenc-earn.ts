/**
 * EARN on AgenC — an Axon agent discovers an OPEN task on AgenC's marketplace,
 * does the work with Axon's OWN model, submits a proof of the result, and gets
 * paid SOL on-chain. This is the "outbound earning" direction of federation:
 * yesterday an Axon agent was hired through a listing (`agenc-settle.ts`); this
 * is the open-task / bounty-board path — an Axon agent claims and completes work
 * posted on AgenC and earns for it.
 *
 * Self-orchestrated so it proves end to end: a buyer posts an OPEN task, the
 * Axon worker claims it, Axon's model produces the deliverable, the worker
 * submits a sha-256 proof of it, and the buyer accepts -> AgenC's atomic 4-way
 * split pays the worker (>=60% floor, ~95% here with no operator/referrer legs)
 * to its authority wallet. Receipt at https://agenc.ag/receipt/<acceptSig>.
 *
 * The worker's "thinking" is Axon's REAL execution path (src/lib/providers
 * runWithProvider), so the work is genuinely done by an Axon agent — needs
 * ANTHROPIC_API_KEY in the environment.
 *
 * Two wallets on mainnet (self-dealing is rejected: SELF_TASK_NOT_ALLOWED):
 *   CLUSTER=mainnet ANTHROPIC_API_KEY=... \
 *     SECRET_KEY_WORKER=<base58> SECRET_KEY_BUYER=<base58> \
 *     npx tsx scripts/agenc-earn.ts
 *
 * NOTE: the hosted attestor is MAINNET-ONLY, so the full path only works on
 * mainnet; a devnet run validates register + create-task, then stops at the
 * attestation gate. It only ever builds AgenC instructions + posts specs to the
 * public attestor — no SystemProgram.transfer to any address.
 */
import { readFileSync } from "fs";
import { randomBytes, createHash } from "crypto";
import {
  createMarketplaceClient,
  findAgentPda,
  findTaskPda,
  findProtocolConfigPda,
  fetchProtocolConfig,
  facade,
  values as agenc,
} from "@tetsuo-ai/marketplace-sdk";
import { generateKeyPairSigner, createKeyPairSignerFromBytes, createSolanaRpc, lamports, getBase58Encoder, address } from "@solana/kit";
import type { Agent } from "../src/sdk/types";

const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC_URL = process.env.RPC_URL ?? (CLUSTER === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const ATTESTOR = process.env.ATTESTOR ?? "https://attest.agenc.ag";
const REWARD = BigInt(process.env.REWARD ?? "1000000"); // task reward in SOL lamports (rewardMint null = native SOL); 1_000_000 = 0.001 SOL. Buyer escrows it; worker keeps >=60% on accept.
const STAKE = BigInt(process.env.STAKE ?? "10000000"); // 0.01 SOL min agent stake
const TASK_TYPE = Number(process.env.TASK_TYPE ?? "0"); // 0 = standard open task
const CU_PRICE = BigInt(process.env.CU_PRICE ?? "2000"); // micro-lamports per CU priority fee
const CU_LIMIT = Number(process.env.CU_LIMIT ?? "200000"); // ample for the heaviest facade ix
const AXON_MODEL = process.env.AXON_MODEL ?? "claude-sonnet-5"; // Axon's executor model

const enc = new TextEncoder();
const id32 = (): Uint8Array => new Uint8Array(randomBytes(32)); // unique per run
const hexToBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const sha256 = (s: string): Uint8Array => new Uint8Array(createHash("sha256").update(s, "utf8").digest());

// The Axon job spec (AgenC canonical form). Its hash pins the task; its `task`
// string is the actual work the Axon agent will do.
const SPEC = {
  from: "axon-creator-agent",
  to: "axon-worker-agent",
  task: "In about 150 words, explain why verifiable on-chain receipts matter when autonomous AI agents hire and pay each other across networks.",
  context: { lang: "en", format: "markdown" },
  payment: null as string | null,
};

// The Axon worker agent — a minimal record for Axon's own provider path.
const AXON_AGENT = {
  agentId: "axon-cross-network-worker",
  name: "Axon Worker",
  capabilities: ["summarization", "analysis"],
  provider: "anthropic",
  providerModel: AXON_MODEL,
  providerEndpoint: null,
} as unknown as Agent;

// Do the work with AXON'S OWN execution (dynamic import so its module chain can
// never break this script's load; only the work step needs ANTHROPIC_API_KEY).
async function doTheWork(task: string): Promise<string> {
  const { runWithProvider } = await import("../src/lib/providers");
  const out = await runWithProvider(AXON_AGENT, task, 1000);
  if (!out || !out.trim()) throw new Error("Axon model returned an empty deliverable");
  return out.trim();
}

// Per the attestor's OpenAPI, a clean POST /v1/moderation/{kind} RECORDS the
// moderation on-chain itself. A 200 returns { attested, verdict, specHash,
// attestation:{signature} }; `attested:true` = the record was signed+confirmed.
// The attestor reads our just-created account, so it can 404 / send `retryable`
// while its RPC lags our tx — retry those, but it rate-limits at 6 req/60s per
// IP, so back off gently (~5 requests over ~34s). Non-clean verdict is fatal.
async function attest(kind: "listings" | "tasks", body: Record<string, unknown>): Promise<{ signature: string; specHash: string }> {
  // The attestor reads the account via its OWN Solana RPC, which can transiently
  // 401/429/5xx (their infra). Retry patiently — up to ~2.5 min — while staying
  // under the attestor's 6 req/60s per-IP limit (<=5 requests in any 60s window).
  const backoffMs = [5000, 10000, 15000, 20000, 25000, 30000, 30000, 30000];
  let last = "";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ATTESTOR}/v1/moderation/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean; attested?: boolean; verdict?: string; specHash?: string;
      attestation?: { signature?: string } | null; error?: string; retryable?: boolean; retryAfterSeconds?: number;
    };
    if (res.ok && json.verdict === "clean" && json.attested === true && json.attestation?.signature) {
      return { signature: json.attestation.signature, specHash: json.specHash ?? "" };
    }
    last = `${res.status} ${JSON.stringify(json)}`;
    if (res.ok && json.verdict && json.verdict !== "clean") break; // content rejected — do not retry
    const transient = Boolean(json.retryable) || res.status >= 500 || res.status === 429 || res.status === 404;
    if (!transient || attempt >= backoffMs.length) break;
    const wait = json.retryAfterSeconds ? json.retryAfterSeconds * 1000 : backoffMs[attempt];
    console.log(`      attestor ${kind} ${res.status} (transient), retry in ${Math.round(wait / 1000)}s [${attempt + 1}/${backoffMs.length}]`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(`attestor ${kind} failed: ${last}`);
}

// Moderator pubkey is the hosted attestor's fixed signer, published at /v1/info
// (not in the attestation response). Also asserts it serves our cluster.
async function fetchModerator() {
  const res = await fetch(`${ATTESTOR}/v1/info`);
  const j = (await res.json().catch(() => ({}))) as { moderator?: string; cluster?: string; signerConfigured?: boolean };
  if (!j.moderator || !j.signerConfigured) throw new Error(`attestor not ready: ${JSON.stringify(j)}`);
  if (j.cluster !== CLUSTER) throw new Error(`attestor serves cluster "${j.cluster}", not "${CLUSTER}" — cannot attest`);
  return address(j.moderator);
}

async function loadKey(b58?: string, file?: string) {
  let bytes: Uint8Array;
  if (b58) bytes = new Uint8Array(getBase58Encoder().encode(b58));
  else if (file) {
    const raw = readFileSync(file, "utf8").trim();
    bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(getBase58Encoder().encode(raw));
  } else throw new Error("no key");
  if (bytes.length !== 64) throw new Error(`expected 64-byte secret key, got ${bytes.length}`);
  return createKeyPairSignerFromBytes(bytes);
}

async function devnetSigner() {
  const rpc = createSolanaRpc(RPC_URL);
  const s = await generateKeyPairSigner();
  for (let a = 0; a < 5; a++) {
    try { await rpc.requestAirdrop(s.address, lamports(1_000_000_000n)).send(); break; }
    catch { await new Promise((r) => setTimeout(r, 2500)); }
  }
  for (let i = 0; i < 40; i++) { const { value } = await rpc.getBalance(s.address).send(); if (value > 0n) break; await new Promise((r) => setTimeout(r, 1000)); }
  return s;
}

async function main() {
  console.log(`\n=== AgenC earn · cluster=${CLUSTER} · rpc=${RPC_URL} ===`);
  const rpc = createSolanaRpc(RPC_URL);

  // Two distinct roles. Mainnet needs two real wallets (self-dealing rejected).
  let worker, buyer;
  if (CLUSTER === "mainnet") {
    const w = process.env.SECRET_KEY_WORKER ?? process.env.SECRET_KEY;
    const b = process.env.SECRET_KEY_BUYER ?? process.env.SECRET_KEY;
    worker = await loadKey(w, process.env.KEYPAIR_WORKER ?? process.env.KEYPAIR);
    buyer = await loadKey(b, process.env.KEYPAIR_BUYER ?? process.env.KEYPAIR);
  } else {
    worker = await devnetSigner();
    buyer = await devnetSigner();
  }
  console.log("worker:", worker.address);
  console.log("buyer :", buyer.address);

  if (worker.address === buyer.address && !process.env.ALLOW_SELF_HIRE) {
    throw new Error(
      "worker and buyer are the same wallet — AgenC rejects self-dealing (SELF_TASK_NOT_ALLOWED). " +
      "Provide two keys: SECRET_KEY_WORKER=<base58> SECRET_KEY_BUYER=<base58> (fund each ~0.08 SOL). " +
      "To attempt one wallet anyway, set ALLOW_SELF_HIRE=1.",
    );
  }

  // The worker does the work with Axon's model at [6/7] — fail NOW if its key is
  // missing, before register/create/claim spend SOL (mainnet only; devnet stops
  // at [3] before the work step).
  if (CLUSTER === "mainnet" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — the Axon worker needs it to do the work at [6/7]. Set it before running; no SOL is spent until it is.");
  }

  // Preflight both balances BEFORE any spend. Worker needs the AgenC ~0.021 SOL
  // go-live floor (stake + agent/claim/submission rents + fees), reclaimed as it settles.
  const MIN_LAMPORTS = BigInt(process.env.MIN_LAMPORTS ?? "50000000"); // 0.05 SOL each
  for (const [role, s] of [["worker", worker], ["buyer", buyer]] as const) {
    const { value } = await rpc.getBalance(s.address).send();
    console.log(`      ${role} balance: ${(Number(value) / 1e9).toFixed(4)} SOL`);
    if (value < MIN_LAMPORTS) {
      throw new Error(`${role} ${s.address} has ${(Number(value) / 1e9).toFixed(4)} SOL; needs >= ${(Number(MIN_LAMPORTS) / 1e9).toFixed(2)} SOL. Fund it and rerun.`);
    }
  }

  const fee = { computeUnitPrice: CU_PRICE, computeUnitLimit: CU_LIMIT }; // priority fee on every tx
  const workerClient = createMarketplaceClient({ rpcUrl: RPC_URL, signer: worker, ...fee });
  const buyerClient = createMarketplaceClient({ rpcUrl: RPC_URL, signer: buyer, ...fee });

  const specHashHex = (await agenc.canonicalJobSpecHash(SPEC)).hex;
  const specHash = hexToBytes(specHashHex);
  const specUri = `agenc://job-spec/sha256/${specHashHex}`;
  // AgenC's on-chain `description` is a CONTENT COMMITMENT, not prose: a 32-byte
  // sha256 digest in bytes 0..32 with bytes 32..64 zeroed (the program's
  // validate_description_is_content_hash rejects any non-zero tail so readable
  // text can't be smuggled on-chain). Commit to the job-spec hash; the real task
  // text lives in the moderated job spec.
  const descriptionCommitment = new Uint8Array(64);
  descriptionCommitment.set(specHash.slice(0, 32), 0);
  const workerAgentId = id32();
  const buyerAgentId = id32();
  const taskId = id32();

  console.log("\n[1/7] register worker agent (the Axon agent)");
  await workerClient.registerAgent({ authority: worker, agentId: workerAgentId, capabilities: 1n, endpoint: "https://axon-agents.com", metadataUri: null, stakeAmount: STAKE });
  const [workerAgent] = await findAgentPda({ agentId: workerAgentId });

  console.log("[2/7] register buyer agent (posts the open task)");
  await buyerClient.registerAgent({ authority: buyer, agentId: buyerAgentId, capabilities: 1n, endpoint: "https://axon-agents.com", metadataUri: null, stakeAmount: STAKE });
  const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

  console.log("[3/7] buyer posts an OPEN task");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  await buyerClient.send([await facade.createTask({
    creatorAgent: buyerAgent, authority: buyer, creator: buyer, taskId,
    requiredCapabilities: 1n, description: descriptionCommitment, rewardAmount: REWARD, maxWorkers: 1,
    deadline, taskType: TASK_TYPE, constraintHash: null, minReputation: 0, rewardMintArg: null, referrer: null, referrerFeeBps: 0,
  })]);
  const [task] = await findTaskPda({ creator: buyer.address, taskId });
  console.log("      task:", String(task));

  // Initialize the task's validation config (CreatorReview): submitTaskResult and
  // acceptTaskResult both require this account to exist — the creator reviews and
  // accepts the worker's result. Without it: AccountNotInitialized (3012) on submit.
  await buyerClient.send([await facade.configureTaskValidation({
    task, creator: buyer, mode: 1 /* ValidationMode.CreatorReview */, reviewWindowSecs: 86400n, validatorQuorum: 0, attestor: null,
  })]);
  console.log("      validation configured (creator review)");

  // The hosted attestor is mainnet-only, so claim->settle can't proceed on devnet.
  if (CLUSTER !== "mainnet") {
    console.log("\n=== devnet dry-run OK — register + open task validated (steps 1-3). ===");
    console.log("The hosted attestor serves mainnet only; run with CLUSTER=mainnet to attest, claim, work + settle.");
    return;
  }

  console.log("[4/7] attest task (pre-pin) + pin job spec so it is claimable");
  const moderator = await fetchModerator();
  const a = await attest("tasks", { task: String(task), jobSpecHash: specHashHex, spec: SPEC });
  if (a.specHash && a.specHash !== specHashHex) throw new Error(`spec hash mismatch — attestor:${a.specHash} ours:${specHashHex}`);
  console.log("      attest tx:", a.signature);
  await buyerClient.send([await facade.setTaskJobSpec({ task, creator: buyer, jobSpecHash: specHash, jobSpecUri: specUri, moderator, moderatorIsAttestor: true })]);

  console.log("[5/7] Axon worker claims the open task");
  await workerClient.claimTaskWithJobSpec({ task, worker: workerAgent, authority: worker });

  console.log("[6/7] Axon agent does the work + submits proof");
  const deliverable = await doTheWork(SPEC.task);
  console.log("      deliverable:", deliverable.length, "chars —", JSON.stringify(deliverable.slice(0, 80)) + "…");
  const proofHash = sha256(deliverable);
  await workerClient.submitTaskResult({
    task, worker: workerAgent, authority: worker,
    proofHash, resultData: enc.encode("axon:deliverable:sha256"), // <=64-byte pointer; proofHash commits to the real output
  });

  console.log("[7/7] buyer accepts -> escrow settles to the Axon worker");
  const [protocolConfig] = await findProtocolConfigPda();
  const cfg = await fetchProtocolConfig(rpc, protocolConfig);
  const treasury = cfg.data.treasury;
  const acc = await buyerClient.acceptTaskResult({ task, worker: workerAgent, treasury, creator: buyer, workerAuthority: worker.address });

  console.log("\n=== DONE — Axon agent earned on AgenC ===");
  console.log("task:    ", String(task));
  console.log("worker:  ", String(workerAgent), "(paid to", worker.address + ")");
  console.log("receipt: ", `https://agenc.ag/receipt/${acc.signature}`);
  console.log("explorer:", `https://solscan.io/account/${task}`);

  // Fold this earning into an Axon agent's PORTABLE Proof Score — an agent's
  // reputation should follow it across networks, not reset at the boundary. Set
  // AXON_AGENT_ID to the Axon agent to credit. Best-effort: a price hiccup or DB
  // issue must never fail an already-settled on-chain earning.
  const creditAgent = process.env.AXON_AGENT_ID;
  if (creditAgent) {
    try {
      const { recordAgencEarning } = await import("../src/lib/integrations/agencEarnings");
      const rec = await recordAgencEarning({
        agentId: creditAgent,
        sol: Number(REWARD) / 1e9, // reward settled for the work; the receipt is authoritative
        settleSig: acc.signature,
        settledAt: new Date().toISOString(),
      });
      console.log(`\nfolded into Proof Score of ${creditAgent}: +${rec.usdc} USDC (cross-network · agenc, verify via receipt)`);
    } catch (e) {
      console.warn("\n(proof-score credit skipped:", (e as Error).message + ")");
    }
  } else {
    console.log("\n(set AXON_AGENT_ID to fold this earning into an Axon agent's Proof Score)");
  }
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
