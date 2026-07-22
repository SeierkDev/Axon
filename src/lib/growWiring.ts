// Wires the grow-yourself engine to reality: the agent's own reasoning runs on
// its configured provider (its "brain"), while discovery, hiring, and payment go
// through Axon's PUBLIC HTTP API exactly as any external client would — same
// endpoints, same auth, same on-chain/balance settlement, same verifiable
// receipts. Nothing here is privileged; the agent is just a well-behaved caller.
import { getAgentById } from "./agents";
import { getProvider } from "./providers";
import { payUsdc, PAYMENT_RECEIVER_WALLET_ADDRESS } from "./solana";
import type { GrowDeps, GrowCandidate } from "./growRunner";

const THINK_SYSTEM =
  "You are an autonomous agent operating on the Axon marketplace with a real budget. You reason concisely and produce concrete, usable output — no filler.";

interface ApiAgent {
  agentId: string;
  name?: string;
  price?: string | null;
  proofScore?: number;
  capabilities?: string[];
}

/** Parse a listing price to USDC. 0 = free lane; null = not USDC-priced (can't pay from a USDC balance). */
function parseUsdc(price?: string | null): number | null {
  if (!price) return 0;
  const m = price.trim().match(/^([\d.]+)\s*USDC$/i);
  return m ? parseFloat(m[1]) : null;
}

/** USDC amount settled/escrowed for a task, from its public receipt (0 if unavailable). */
async function receiptCostUsdc(base: string, taskId: string): Promise<number> {
  try {
    const rr = await fetch(`${base}/api/receipts/${encodeURIComponent(taskId)}/public`);
    if (rr.ok) {
      const pr = (await rr.json()) as { settlement?: { amount: number; currency: string } };
      if (pr.settlement?.currency === "USDC") return pr.settlement.amount;
    }
  } catch {
    // best-effort
  }
  return 0;
}

export interface GrowWiringConfig {
  self: string;          // the entrepreneur's agentId (must own the API key)
  apiKey: string;        // its API key — authorizes hires and reads private output back
  baseUrl?: string;      // Axon API base (defaults to $AXON_BASE_URL or localhost)
  hireTimeoutMs?: number;
  walletSecret?: string; // if set, priced hires are paid ON-CHAIN from this wallet
                         // (base64 64-byte secret); otherwise they draw from balance
}

export function buildGrowDeps(cfg: GrowWiringConfig): GrowDeps {
  // Self-call over IPv4 explicitly: inside the container "localhost" can resolve to
  // IPv6 ::1, which the IPv4-bound server (0.0.0.0:PORT) refuses — hanging the run.
  const base = (cfg.baseUrl ?? process.env.AXON_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey}` };
  const hireTimeoutMs = cfg.hireTimeoutMs ?? 180_000;

  const think: GrowDeps["think"] = async (prompt, opts) => {
    const me = getAgentById(cfg.self);
    if (!me) throw new Error(`grow agent "${cfg.self}" not found`);
    return getProvider(me).complete(THINK_SYSTEM, prompt, opts?.maxTokens ?? 1500);
  };

  const search: GrowDeps["search"] = async (q) => {
    const params = new URLSearchParams({ sort: "proven", limit: String(q.limit ?? 10) });
    if (q.capability) params.set("capabilities", q.capability);
    const res = await fetch(`${base}/api/agents?${params.toString()}`, { headers: auth });
    if (!res.ok) throw new Error(`agent search failed: HTTP ${res.status}`);
    const { agents } = (await res.json()) as { agents: ApiAgent[] };
    const ceiling = q.maxPriceUsdc ?? Infinity;
    return agents
      .map((a): GrowCandidate | null => {
        const priceUsdc = parseUsdc(a.price);
        if (priceUsdc === null || priceUsdc > ceiling) return null; // non-USDC or over budget
        return {
          agentId: a.agentId,
          name: a.name ?? a.agentId,
          priceUsdc,
          proofScore: a.proofScore,
          capabilities: a.capabilities ?? [],
        };
      })
      .filter((x): x is GrowCandidate => x !== null);
  };

  const hire: GrowDeps["hire"] = async ({ to, task, context, priceUsdc }) => {
    // Free-lane specialists need no payment. Priced ones are paid either ON-CHAIN
    // (the agent signs a real USDC transfer from its own wallet — non-custodial) or
    // from its earned balance. Either way it's a real hire with a real receipt.
    const payload: Record<string, unknown> = { from: cfg.self, to, task, context };
    let committedUsdc = 0; // USDC irrevocably moved on-chain — the accounting floor if a receipt is slow/missing
    if (priceUsdc > 0) {
      if (cfg.walletSecret) {
        if (!PAYMENT_RECEIVER_WALLET_ADDRESS) throw new Error("PAYMENT_RECEIVER_WALLET_ADDRESS not configured");
        // The on-chain payment is irreversible and happens BEFORE task creation, so
        // confirm the specialist still exists and pay its CURRENT exact price — never
        // pay for a hire that won't be created, and never under/overpay a stale price.
        const agRes = await fetch(`${base}/api/agents/${encodeURIComponent(to)}`, { headers: auth });
        if (!agRes.ok) throw new Error(`specialist ${to} unavailable before payment (HTTP ${agRes.status}) — not paying`);
        const amount = parseUsdc((await agRes.json() as { price?: string | null }).price);
        if (amount === null) throw new Error(`specialist ${to} is no longer USDC-priced — not paying`);
        // Never pay above what discovery authorized: if the price rose, the budget
        // cap would reject the task AFTER payment (funds lost). Bail before paying.
        if (amount > priceUsdc) throw new Error(`specialist ${to} price rose (${amount} > ${priceUsdc} USDC) since discovery — not paying`);
        if (amount > 0) {
          const { signature, payerWallet } = await payUsdc(cfg.walletSecret, PAYMENT_RECEIVER_WALLET_ADDRESS, amount);
          payload.paymentSignature = signature;
          payload.payerWallet = payerWallet;
          committedUsdc = amount;
        }
        // amount === 0 → the listing went free; create the hire with no payment
      } else {
        payload.paymentMethod = "balance";
      }
    }
    const createRes = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!createRes.ok) {
      throw new Error(`hire create failed (HTTP ${createRes.status}): ${(await createRes.text()).slice(0, 200)}`);
    }
    const created = (await createRes.json()) as { taskId: string; status?: string };
    const taskId = created.taskId;

    // Poll to a terminal state — the specialist runs the task (real inference).
    const deadline = Date.now() + hireTimeoutMs;
    let status = created.status ?? "queued";
    let output: string | undefined;
    let error: string | undefined;
    while (status !== "completed" && status !== "failed") {
      if (Date.now() >= deadline) {
        // Money may already be committed (paid on-chain / escrowed) — report it so the
        // budget never under-counts a timed-out hire whose escrow could still settle.
        return { taskId, status: "timeout", costUsdc: (await receiptCostUsdc(base, taskId)) || committedUsdc };
      }
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const t = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`, { headers: auth });
        if (t.ok) {
          const tj = (await t.json()) as { status: string; output?: string; error?: string };
          status = tj.status;
          output = tj.output;
          error = tj.error;
        }
      } catch {
        // transient read failure — keep polling until the deadline
      }
    }
    if (status === "failed") return { taskId, status: "failed", error: error ?? "task failed", costUsdc: 0 };

    // Cost from the public receipt's settlement (authoritative); fall back to what we
    // know moved on-chain so a slow receipt never under-reports real spend.
    const costUsdc = (await receiptCostUsdc(base, taskId)) || committedUsdc;
    return { taskId, status: "completed", output: output ?? "", costUsdc, receiptUrl: `/r/${taskId}` };
  };

  return { self: cfg.self, think, search, hire };
}
