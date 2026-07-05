/**
 * Settle a task ACROSS networks on AgenC mainnet — the "a task hired and paid on
 * another network" milestone. Runs the full flow against AgenC's live program:
 *   register worker + buyer -> list -> attest listing -> hire -> attest task ->
 *   pin job spec -> claim -> complete (escrow settles to the worker).
 *
 * Moderation uses AgenC's HOSTED attestor (attest.agenc.ag) — no bond, no
 * self-registration. A clean POST records the moderation on-chain itself; the
 * moderator pubkey is read live from the attestor's /v1/info (never hardcoded).
 *
 * NOTE: the hosted attestor is MAINNET-ONLY (attest.agenc.ag serves cluster
 * "mainnet"), so the full hire->settle path only works on mainnet. A devnet run
 * validates key loading + registration + listing (steps 1-3) for free, then
 * stops at the attestation gate — a wiring dry-run, not a settlement.
 *   npx tsx scripts/agenc-settle.ts            # devnet dry-run (stops at [4/8])
 *
 * Mainnet (real SOL — reads YOUR key(s) locally, never leaves your machine).
 * Use TWO wallets: the program rejects self-dealing (SELF_TASK_NOT_ALLOWED), and a
 * genuine buyer->worker hire is a stronger proof than a self-hire anyway:
 *   CLUSTER=mainnet SECRET_KEY_WORKER=<base58> SECRET_KEY_BUYER=<base58> \
 *     npx tsx scripts/agenc-settle.ts
 *   (to attempt one wallet as both — expected to be rejected on-chain — set
 *    ALLOW_SELF_HIRE=1 with SECRET_KEY=<base58>.)
 *
 * It only ever builds AgenC instructions + posts specs to the public attestor.
 * No SystemProgram.transfer to any address.
 */
import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import {
  createMarketplaceClient,
  findAgentPda,
  findTaskPda,
  findHireRecordPda,
  findProtocolConfigPda,
  fetchProtocolConfig,
  facade,
  values as agenc,
} from "@tetsuo-ai/marketplace-sdk";
import { generateKeyPairSigner, createKeyPairSignerFromBytes, createSolanaRpc, lamports, getBase58Encoder, address } from "@solana/kit";

const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC_URL = process.env.RPC_URL ?? (CLUSTER === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const ATTESTOR = process.env.ATTESTOR ?? "https://attest.agenc.ag";
const PRICE = BigInt(process.env.PRICE ?? "1000000"); // task price in SOL lamports (priceMint null = native SOL); 1_000_000 = 0.001 SOL. Buyer escrows it; settles to worker on completion.
const STAKE = BigInt(process.env.STAKE ?? "10000000"); // 0.01 SOL min agent stake
// Priority fee so txs land within the 60s confirm window even on a busy mainnet
// (default is zero, which can time out mid-flow and waste already-spent SOL). Fee
// bills on CU_LIMIT, so right-size it: ~2k µLamports x 200k CU ~= 0.0004 SOL/tx.
const CU_PRICE = BigInt(process.env.CU_PRICE ?? "2000"); // micro-lamports per CU
const CU_LIMIT = Number(process.env.CU_LIMIT ?? "200000"); // ample for the heaviest facade ix (~33k CU actual)

const enc = new TextEncoder();
const fixed = (s: string, n: number): Uint8Array => { const b = new Uint8Array(n); b.set(enc.encode(s).slice(0, n)); return b; };
const id32 = (): Uint8Array => new Uint8Array(randomBytes(32)); // unique per run — no collisions
const hexToBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

// The Axon job spec (AgenC canonical form). Its hash pins the listing + task.
const SPEC = {
  from: "axon-creator-agent",
  to: "axon-worker-agent",
  task: "Summarize the weekly agent-network report.",
  context: { lang: "en", format: "markdown" },
  payment: null as string | null,
};

// Per the attestor's OpenAPI, a clean POST /v1/moderation/{kind} RECORDS the
// moderation on-chain itself (record_*_moderation) — so this HTTP call is all the
// hire/setJobSpec gate needs. A 200 returns { attested, verdict, specHash,
// attestation:{signature} }; `attested:true` means the on-chain record was signed
// + confirmed. The attestor reads our just-created account on-chain, so it can 404
// (or send `retryable`) while its RPC lags our tx — those we retry. It rate-limits
// at 6 req / 60s per IP, so back off gently: ~5 requests over ~34s, past finality
// (~13s), never self-429. A non-clean verdict (suspicious/blocked) is fatal.
async function attest(kind: "listings" | "tasks", body: Record<string, unknown>): Promise<{ signature: string; specHash: string }> {
  const backoffMs = [3000, 6000, 10000, 15000];
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
    if (res.ok && json.verdict && json.verdict !== "clean") break; // suspicious/blocked — content rejected, do not retry
    const transient = Boolean(json.retryable) || res.status >= 500 || res.status === 429 || res.status === 404; // 404 = attestor RPC lag on our fresh account
    if (!transient || attempt >= backoffMs.length) break;
    await new Promise((r) => setTimeout(r, (json.retryAfterSeconds ? json.retryAfterSeconds * 1000 : backoffMs[attempt])));
  }
  throw new Error(`attestor ${kind} failed: ${last}`);
}

// The moderator pubkey is NOT in the attestation response — it's the hosted
// attestor's fixed signer, published at /v1/info. hire + setJobSpec must name it
// as the moderator (with moderatorIsAttestor:true). Also asserts the attestor
// serves our cluster, so we never attest a mainnet listing against a devnet run.
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
  const rpc = createSolanaRpc(RPC_URL); // locally-typed devnet rpc (has requestAirdrop)
  const s = await generateKeyPairSigner();
  for (let a = 0; a < 5; a++) {
    try { await rpc.requestAirdrop(s.address, lamports(1_000_000_000n)).send(); break; }
    catch { await new Promise((r) => setTimeout(r, 2500)); }
  }
  for (let i = 0; i < 40; i++) { const { value } = await rpc.getBalance(s.address).send(); if (value > 0n) break; await new Promise((r) => setTimeout(r, 1000)); }
  return s;
}

async function main() {
  console.log(`\n=== AgenC settle · cluster=${CLUSTER} · rpc=${RPC_URL} ===`);
  const rpc = createSolanaRpc(RPC_URL);

  // Two distinct roles. Mainnet needs two real wallets (self-dealing is rejected on-chain).
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

  // Fail fast BEFORE spending: the program forbids self-dealing (SELF_TASK_NOT_ALLOWED),
  // so one wallet as both sides would revert at [5/8] hire after wasting 2 registrations.
  if (worker.address === buyer.address && !process.env.ALLOW_SELF_HIRE) {
    throw new Error(
      "worker and buyer are the same wallet — AgenC rejects self-dealing (SELF_TASK_NOT_ALLOWED). " +
      "Provide two keys: SECRET_KEY_WORKER=<base58> SECRET_KEY_BUYER=<base58> (fund each ~0.08 SOL). " +
      "To attempt one wallet anyway, set ALLOW_SELF_HIRE=1.",
    );
  }

  // Preflight both balances BEFORE any spend, so an underfunded buyer can't fail
  // after the worker has already paid to register (partial-spend loss).
  const MIN_LAMPORTS = BigInt(process.env.MIN_LAMPORTS ?? "50000000"); // 0.05 SOL each
  for (const [role, s] of [["worker", worker], ["buyer", buyer]] as const) {
    const { value } = await rpc.getBalance(s.address).send();
    console.log(`      ${role} balance: ${(Number(value) / 1e9).toFixed(4)} SOL`);
    if (value < MIN_LAMPORTS) {
      throw new Error(`${role} ${s.address} has ${(Number(value) / 1e9).toFixed(4)} SOL; needs >= ${(Number(MIN_LAMPORTS) / 1e9).toFixed(2)} SOL. Fund it and rerun.`);
    }
  }

  const fee = { computeUnitPrice: CU_PRICE, computeUnitLimit: CU_LIMIT }; // priority fee on every tx (client + .send)
  const workerClient = createMarketplaceClient({ rpcUrl: RPC_URL, signer: worker, ...fee });
  const buyerClient = createMarketplaceClient({ rpcUrl: RPC_URL, signer: buyer, ...fee });

  const specHashHex = (await agenc.canonicalJobSpecHash(SPEC)).hex;
  const specHash = hexToBytes(specHashHex);
  const specUri = `agenc://job-spec/sha256/${specHashHex}`;
  const workerAgentId = id32();
  const buyerAgentId = id32();
  const listingId = id32();
  const taskId = id32();

  console.log("\n[1/8] register worker agent");
  await workerClient.registerAgent({ authority: worker, agentId: workerAgentId, capabilities: 1n, endpoint: "https://axon-agents.com", metadataUri: null, stakeAmount: STAKE });
  const [workerAgent] = await findAgentPda({ agentId: workerAgentId });

  console.log("[2/8] register buyer agent");
  await buyerClient.registerAgent({ authority: buyer, agentId: buyerAgentId, capabilities: 1n, endpoint: "https://axon-agents.com", metadataUri: null, stakeAmount: STAKE });
  const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

  console.log("[3/8] create service listing");
  await workerClient.createServiceListing({
    providerAgent: workerAgent, authority: worker, listingId,
    name: fixed("Axon Network", 32), category: fixed("agent-network", 32), tags: fixed("axon,cross-network", 64),
    specHash, specUri, price: PRICE, priceMint: null, requiredCapabilities: 1n, defaultDeadlineSecs: 3600n, maxOpenJobs: 0, operator: null, operatorFeeBps: 0,
  });
  const [listing] = await facade.findListingPda({ providerAgent: workerAgent, listingId });
  console.log("      listing:", String(listing));

  // The hosted attestor is mainnet-only, so hire→settle can't proceed on devnet.
  if (CLUSTER !== "mainnet") {
    console.log("\n=== devnet dry-run OK — wiring validated through listing (steps 1-3). ===");
    console.log("The hosted attestor serves mainnet only; run with CLUSTER=mainnet to hire + settle.");
    return;
  }

  console.log("[4/8] attest listing via hosted attestor (records moderation on-chain)");
  const moderator = await fetchModerator();
  const a1 = await attest("listings", { listing: String(listing), spec: SPEC });
  if (a1.specHash && a1.specHash !== specHashHex) throw new Error(`spec hash mismatch — attestor:${a1.specHash} ours:${specHashHex}`);
  console.log("      moderator:", String(moderator), "· attest tx:", a1.signature);

  console.log("[5/8] buyer hires from listing");
  await buyerClient.hireFromListing({
    listing, creatorAgent: buyerAgent, authority: buyer, creator: buyer, taskId,
    expectedPrice: PRICE, expectedVersion: 1n, listingSpecHash: specHash, moderator, moderatorIsAttestor: true,
  });
  const [task] = await findTaskPda({ creator: buyer.address, taskId });
  console.log("      task:", task);

  console.log("[6/8] attest task (pre-pin) + pin job spec");
  const a2 = await attest("tasks", { task: String(task), jobSpecHash: specHashHex, spec: SPEC });
  if (a2.specHash && a2.specHash !== specHashHex) throw new Error(`task spec hash mismatch — attestor:${a2.specHash} ours:${specHashHex}`);
  console.log("      task attest tx:", a2.signature);
  await buyerClient.send([await facade.setTaskJobSpec({ task, creator: buyer, jobSpecHash: specHash, jobSpecUri: specUri, moderator, moderatorIsAttestor: true })]);

  console.log("[7/8] worker claims");
  await workerClient.claimTaskWithJobSpec({ task, worker: workerAgent, authority: worker });

  console.log("[8/8] worker completes -> escrow settles");
  const [protocolConfig] = await findProtocolConfigPda();
  const cfg = await fetchProtocolConfig(rpc, protocolConfig);
  const treasury = cfg.data.treasury;
  const [hireRecord] = await findHireRecordPda({ task });
  await workerClient.send([await facade.completeTask({ task, creator: buyer.address, worker: workerAgent, treasury, authority: worker, hireRecord, proofHash: fixed("axon-cross-network", 32), resultData: null })]);

  console.log("\n=== DONE — task settled across networks ===");
  console.log("task:   ", String(task));
  console.log("worker: ", String(workerAgent));
  console.log(`explorer: https://solscan.io/account/${task}`); // mainnet-only past [4/8]
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
