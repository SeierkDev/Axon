// The Axon connector: everything the plugin does over Axon's PUBLIC HTTP API,
// paying from the SAK agent's own Solana wallet. No Axon account needed — an
// on-chain USDC payment IS the authorization, and an anonymous hire returns a
// claimToken that reads the private result back.

import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { SolanaAgentKit } from "./sak.js";

export const DEFAULT_ENDPOINT = "https://axon-agents.com";

export function axonEndpoint(agent: SolanaAgentKit): string {
  const cfg = (agent.config?.AXON_ENDPOINT as string | undefined) ?? undefined;
  return (cfg || (typeof process !== "undefined" ? process.env.AXON_ENDPOINT : undefined) || DEFAULT_ENDPOINT).replace(/\/$/, "");
}

export interface AxonAgent {
  agentId: string;
  name?: string;
  capabilities?: string[];
  price?: string | null;
  proofScore?: number;
  proofScoreTier?: string;
}

/** Parse a price string to USDC. 0 = free lane; null = not USDC-priced (unpayable here). */
export function parseUsdcPrice(price?: string | null): number | null {
  if (!price) return 0;
  const m = price.trim().match(/^([\d.]+)\s*USDC$/i);
  return m ? parseFloat(m[1]) : null;
}

/** Search proven specialists, ranked by Proof Score. */
export async function searchAgents(
  base: string,
  q: { capability?: string; limit?: number },
): Promise<AxonAgent[]> {
  const params = new URLSearchParams({ sort: "proven", limit: String(q.limit ?? 10) });
  if (q.capability) params.set("capability", q.capability);
  const res = await fetch(`${base}/api/agents?${params.toString()}`);
  if (!res.ok) throw new Error(`Axon agent search failed: HTTP ${res.status}`);
  const { agents } = (await res.json()) as { agents: AxonAgent[] };
  return agents;
}

interface PayRequirement {
  payTo: PublicKey;
  mint: PublicKey;
  amount: bigint;
  decimals: number;
}

/** Probe an agent's price via x402. Returns null for a free-lane agent. */
async function getRequirement(base: string, agentId: string): Promise<PayRequirement | null> {
  const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/x402`);
  if (res.status === 200) return null; // free lane
  // A non-USDC (e.g. SOL) price returns 503 from the server; this plugin pays USDC only.
  if (res.status === 503) throw new Error(`Agent "${agentId}" is not priced in USDC — this plugin only pays USDC hires.`);
  if (res.status !== 402) throw new Error(`Axon price probe failed: HTTP ${res.status}`);
  const raw = res.headers.get("x-payment-required");
  if (!raw) throw new Error("Axon x402: missing X-Payment-Required header");
  let parsed: { accepts?: Array<{ payToAddress: string; asset: string; maxAmountRequired: string; extra?: { contractAddress?: string; decimals?: number } }> };
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error("Axon x402: could not decode payment requirements");
  }
  const opt = parsed.accepts?.[0];
  if (!opt) throw new Error("Axon x402: no payment option offered");
  return {
    payTo: new PublicKey(opt.payToAddress),
    mint: new PublicKey(opt.extra?.contractAddress || opt.asset),
    amount: BigInt(opt.maxAmountRequired),
    decimals: opt.extra?.decimals ?? 6,
  };
}

/** Pay the required USDC from the agent's wallet to the marketplace pay address. */
async function payFromWallet(
  agent: SolanaAgentKit,
  req: PayRequirement,
  priorityFeeMicroLamports: number,
): Promise<{ signature: string; payerWallet: string }> {
  const conn = agent.connection;
  const owner = agent.wallet.publicKey;
  const fromAta = getAssociatedTokenAddressSync(req.mint, owner, true);
  const toAta = getAssociatedTokenAddressSync(req.mint, req.payTo, true);

  // A priority fee + the ATA-idempotent create make the transfer land reliably on
  // mainnet (the recipient ATA may not exist; congestion drops unfunded txs).
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    createAssociatedTokenAccountIdempotentInstruction(owner, toAta, req.payTo, req.mint),
    createTransferCheckedInstruction(fromAta, req.mint, toAta, owner, req.amount, req.decimals),
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;

  const signed = await agent.wallet.signTransaction(tx);
  const signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 5 });
  // Blockhash-based confirmation (not the deprecated one-shot) so we wait within the
  // transaction's real validity window.
  const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`payment failed on-chain: ${JSON.stringify(conf.value.err)}`);
  return { signature, payerWallet: owner.toBase58() };
}

export interface HireResult {
  taskId: string;
  status: string;
  output?: string;
  error?: string;
  paid: boolean;
  costUsdc: number;
  receiptUrl: string;
}

/**
 * Hire an agent: pay its price from the wallet (if any), submit anonymously, and
 * poll to completion with the claimToken so the private output comes back.
 */
export async function hireAgent(
  agent: SolanaAgentKit,
  base: string,
  agentId: string,
  task: string,
  opts: { timeoutMs?: number; pollMs?: number; priorityFeeMicroLamports?: number; maxPriceUsdc?: number } = {},
): Promise<HireResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 2500;
  const priorityFee = opts.priorityFeeMicroLamports ?? 50_000;

  const req = await getRequirement(base, agentId);
  const payload: Record<string, unknown> = { from: "anonymous", to: agentId, task };
  let paid = false;
  let costUsdc = 0;
  if (req && req.amount > 0n) {
    costUsdc = Number(req.amount) / 10 ** req.decimals;
    // Spend cap: refuse before any funds move if the agent costs more than allowed.
    if (opts.maxPriceUsdc != null && costUsdc > opts.maxPriceUsdc) {
      throw new Error(`Agent "${agentId}" costs ${costUsdc} USDC, above the ${opts.maxPriceUsdc} USDC cap — not hiring.`);
    }
    const { signature, payerWallet } = await payFromWallet(agent, req, priorityFee);
    payload.paymentSignature = signature;
    payload.payerWallet = payerWallet;
    paid = true;
  }

  const createRes = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!createRes.ok) {
    throw new Error(`Axon hire failed: HTTP ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
  }
  const created = (await createRes.json()) as { taskId: string; status?: string; claimToken?: string };
  const { taskId, claimToken } = created;
  const receiptUrl = `${base}/r/${taskId}`;

  // The claimToken is the read permission for the private output. Without it (a
  // payment replay), the output isn't readable — return with the public receipt.
  if (!claimToken) {
    return { taskId, status: created.status ?? "queued", paid, costUsdc, receiptUrl, error: "no read token was issued (payment replay?) — the public receipt is still viewable" };
  }

  const deadline = Date.now() + timeoutMs;
  let status = created.status ?? "queued";
  let output: string | undefined;
  let error: string | undefined;
  while (status !== "completed" && status !== "failed") {
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const t = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`, {
        headers: { "X-Claim-Token": claimToken },
      });
      if (t.status === 401 || t.status === 403) break; // token rejected — stop, don't spin to the timeout
      if (t.ok) {
        const tj = (await t.json()) as { status: string; output?: string; error?: string };
        status = tj.status;
        output = tj.output;
        error = tj.error;
      }
    } catch {
      // transient — keep polling until the deadline
    }
  }

  return { taskId, status, output, error, paid, costUsdc, receiptUrl };
}

/** An agent's Proof Score and the public evidence behind it. */
export async function getProofScore(base: string, agentId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/proof-score`);
  if (!res.ok) throw new Error(`Axon proof-score failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export function receiptUrl(base: string, taskId: string): string {
  return `${base}/r/${taskId}`;
}
