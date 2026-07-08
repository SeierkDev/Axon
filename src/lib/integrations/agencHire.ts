// Hire an AgenC agent from inside Axon — the buyer side of cross-network hire.
//
// Non-custodial: the user signs + pays with their OWN Phantom wallet. Axon only
// builds the AgenC transactions (server) and runs the server-paid attestor
// moderation; no Axon SOL is spent and no secret key is read. Given a real AgenC
// listing (from the discovery feed), this runs the proven hire flow against
// AgenC's live on-chain program: attest the listing -> register a buyer agent +
// hireFromListing (funds the escrow) -> attest the task -> pin the job spec. The
// result is a real funded task on AgenC for that provider to fulfil.
//
// Server-only (imports the marketplace SDK; NEVER import into client code).
// Mirrors scripts/agenc-settle.ts (7 hardening passes on mainnet). Same attestor
// dependency (attest.agenc.ag, mainnet-only) and same self-deal guard.

import {
  findAgentPda,
  findTaskPda,
  fetchServiceListing,
  facade,
  values as agenc,
} from "@tetsuo-ai/marketplace-sdk";
import {
  createSolanaRpc, address,
  createNoopSigner, pipe, createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  compileTransaction, getBase64EncodedWireTransaction,
} from "@solana/kit";
import { randomBytes } from "crypto";

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const ATTESTOR = process.env.ATTESTOR ?? "https://attest.agenc.ag";
const STAKE = BigInt(process.env.STAKE ?? "10000000"); // 0.01 SOL min agent stake

const id32 = (): Uint8Array => new Uint8Array(randomBytes(32));

// The hosted attestor RECORDS moderation on-chain on a clean POST (record_*_moderation);
// this HTTP call is the whole gate hire/setJobSpec needs. Retries the transient 404
// (attestor RPC lagging our just-created account) with gentle backoff (rate-limited
// 6/60s). A non-clean verdict is fatal — the content was rejected.
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
      attested?: boolean; verdict?: string; specHash?: string;
      attestation?: { signature?: string } | null; retryable?: boolean; retryAfterSeconds?: number;
    };
    if (res.ok && json.verdict === "clean" && json.attested === true && json.attestation?.signature) {
      return { signature: json.attestation.signature, specHash: json.specHash ?? "" };
    }
    last = `${res.status} ${JSON.stringify(json)}`;
    if (res.ok && json.verdict && json.verdict !== "clean") break; // rejected — do not retry
    const transient = Boolean(json.retryable) || res.status >= 500 || res.status === 429 || res.status === 404;
    if (!transient || attempt >= backoffMs.length) break;
    await new Promise((r) => setTimeout(r, json.retryAfterSeconds ? json.retryAfterSeconds * 1000 : backoffMs[attempt]));
  }
  throw new Error(`attestor ${kind} failed: ${last}`);
}

// The moderator pubkey is the hosted attestor's fixed signer (from /v1/info) — hire +
// setJobSpec name it with moderatorIsAttestor:true. Also confirms the attestor serves
// mainnet, so we never hire against a mismatched cluster.
async function fetchModerator() {
  const res = await fetch(`${ATTESTOR}/v1/info`);
  const j = (await res.json().catch(() => ({}))) as { moderator?: string; cluster?: string; signerConfigured?: boolean };
  if (!j.moderator || !j.signerConfigured) throw new Error(`attestor not ready: ${JSON.stringify(j)}`);
  if (j.cluster !== "mainnet") throw new Error(`attestor serves cluster "${j.cluster}", not mainnet`);
  return address(j.moderator);
}

// ── The hire (the user pays with their OWN wallet) ───────────────────────────
// Axon builds the AgenC transactions + runs the (server-paid) attestor moderation;
// the user's Phantom wallet signs + pays. Two phases, because setTaskJobSpec can
// only run once the task exists AND its moderation is recorded:
//   1. prepareHire  -> attest listing (server), return an UNSIGNED register+hire tx
//   2. client signs+sends it with Phantom  -> the task is now funded on-chain
//   3. finalizeHire -> attest task (server), return an UNSIGNED setTaskJobSpec tx
//   4. client signs+sends it  -> the provider can claim + deliver

// Build an unsigned v0 transaction (fee payer = the user's wallet) and base64-encode
// it for Phantom to sign. The noop signer contributes no signature — Phantom fills it.
async function buildUnsignedTx(
  rpc: ReturnType<typeof createSolanaRpc>,
  feePayer: ReturnType<typeof createNoopSigner>,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
): Promise<string> {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  // Compile WITHOUT signing — the noop fee-payer stays unsigned so the user's
  // wallet fills it. (signTransactionMessageWithSigners would assert full signing
  // and reject the unsigned fee-payer.)
  const tx = compileTransaction(msg);
  return getBase64EncodedWireTransaction(tx);
}

export interface PrepareHireResult {
  hireTx: string; // base64 unsigned tx: register buyer agent + hireFromListing (funds escrow)
  taskPda: string;
  providerAgent: string;
  jobSpecHashHex: string;
  jobSpecUri: string;
  explorerUrl: string;
}

// Phase 1: attest the listing (server) + return the unsigned register+hire tx.
export async function prepareHire(opts: { listingPda: string; task: string; buyerPubkey: string }): Promise<PrepareHireResult> {
  const rpc = createSolanaRpc(RPC_URL);
  const buyer = createNoopSigner(address(opts.buyerPubkey));
  const listing = address(opts.listingPda);

  const acct = await fetchServiceListing(rpc, listing);
  const providerAgent = acct.data.providerAgent;
  if (String(acct.data.authority) === opts.buyerPubkey) {
    throw new Error("this listing is owned by your wallet — AgenC rejects self-dealing");
  }

  const moderator = await fetchModerator();
  const listingSpecHashHex = Buffer.from(acct.data.specHash).toString("hex");
  const la = await attest("listings", { listing: String(listing) });
  if (la.specHash && la.specHash !== listingSpecHashHex) {
    throw new Error(`listing moderation spec-hash mismatch — attestor:${la.specHash} on-chain:${listingSpecHashHex}`);
  }

  const buyerAgentId = id32();
  const registerIx = await facade.registerAgent({ authority: buyer, agentId: buyerAgentId, capabilities: 1n, endpoint: "https://axon-agents.com", metadataUri: null, stakeAmount: STAKE });
  const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

  const spec = { from: "axon-buyer-agent", to: String(providerAgent), task: opts.task, context: { via: "axon", lang: "en" }, payment: null as string | null };
  const jobSpecHashHex = (await agenc.canonicalJobSpecHash(spec)).hex;

  const taskIdBytes = id32();
  const hireIx = await facade.hireFromListing({
    listing, creatorAgent: buyerAgent, authority: buyer, creator: buyer, taskId: taskIdBytes,
    expectedPrice: acct.data.price, expectedVersion: acct.data.version, listingSpecHash: acct.data.specHash, moderator, moderatorIsAttestor: true,
  });
  const [task] = await findTaskPda({ creator: buyer.address, taskId: taskIdBytes });

  const hireTx = await buildUnsignedTx(rpc, buyer, [registerIx, hireIx]);
  return {
    hireTx,
    taskPda: String(task),
    providerAgent: String(providerAgent),
    jobSpecHashHex,
    jobSpecUri: `agenc://job-spec/sha256/${jobSpecHashHex}`,
    explorerUrl: `https://solscan.io/account/${task}`,
  };
}

// Phase 3: attest the task (server) + return the unsigned setTaskJobSpec tx.
export async function finalizeHire(opts: { taskPda: string; buyerPubkey: string; providerAgent: string; task: string; jobSpecHashHex: string; jobSpecUri: string }): Promise<{ setSpecTx: string }> {
  const rpc = createSolanaRpc(RPC_URL);
  const buyer = createNoopSigner(address(opts.buyerPubkey));
  const moderator = await fetchModerator();

  const spec = { from: "axon-buyer-agent", to: opts.providerAgent, task: opts.task, context: { via: "axon", lang: "en" }, payment: null as string | null };
  const a = await attest("tasks", { task: opts.taskPda, jobSpecHash: opts.jobSpecHashHex, spec });
  if (a.specHash && a.specHash !== opts.jobSpecHashHex) throw new Error(`task spec hash mismatch — attestor:${a.specHash} ours:${opts.jobSpecHashHex}`);

  const jobSpecHash = Uint8Array.from(Buffer.from(opts.jobSpecHashHex, "hex"));
  const setSpecIx = await facade.setTaskJobSpec({ task: address(opts.taskPda), creator: buyer, jobSpecHash, jobSpecUri: opts.jobSpecUri, moderator, moderatorIsAttestor: true });
  const setSpecTx = await buildUnsignedTx(rpc, buyer, [setSpecIx]);
  return { setSpecTx };
}
