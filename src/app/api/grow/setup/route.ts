import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@solana/web3.js";
import { createAgent, getAgentById } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { createBudget } from "@/lib/budgets";
import type { Agent } from "@/sdk/types";

export const dynamic = "force-dynamic";

// One-time bootstrap for the grow experiment (guarded by GROW_SECRET): creates the
// entrepreneur's identity + a real Solana wallet, sets a HARD budget cap (enforced
// on every payment), and mints its API key. The apiKey + secretKey are returned
// ONCE — save them as GROW_AGENT_ID / GROW_AGENT_KEY (+ the wallet to fund with USDC).
export async function POST(req: NextRequest) {
  const secret = process.env.GROW_SECRET;
  const provided = req.headers.get("x-grow-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    agentId?: string; name?: string; provider?: Agent["provider"];
    budgetUsdc?: number; perHireCapUsdc?: number;
  };
  const agentId = (body.agentId ?? "the-entrepreneur").trim();
  const budgetUsdc = body.budgetUsdc ?? 20;
  const perHireCapUsdc = body.perHireCapUsdc ?? 4;

  if (getAgentById(agentId)) {
    return NextResponse.json({ error: `agent "${agentId}" already exists — delete it first or pick another agentId` }, { status: 409 });
  }

  // A real Solana wallet: fund it with USDC for the on-chain path later; ownership
  // of the agent is tied to this address so its API key can authorize its hires.
  const kp = Keypair.generate();
  const walletAddress = kp.publicKey.toBase58();
  const secretKey = Buffer.from(kp.secretKey).toString("base64");

  createAgent({
    agentId,
    name: body.name ?? "The Entrepreneur",
    capabilities: ["orchestration"],
    publicKey: walletAddress,
    walletAddress,
    provider: body.provider ?? "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  } as Agent);

  const { apiKey } = createApiKey(walletAddress);

  // Hard spend caps: per-hire and per-day (UTC). checkBudget enforces these inside
  // every payment before any money moves — the agent cannot exceed them.
  createBudget({ agentId, name: "grow experiment", maxPerCallUsdc: perHireCapUsdc, maxPerDayUsdc: budgetUsdc });

  return NextResponse.json({
    agentId,
    walletAddress,
    apiKey,        // set as GROW_AGENT_KEY (shown once)
    secretKey,     // the wallet's secret (base64) — save to fund/sign on-chain later (shown once)
    budget: { perHireCapUsdc, maxPerDayUsdc: budgetUsdc },
    next: "Set GROW_AGENT_ID + GROW_AGENT_KEY in env. For the on-chain paid path, fund the wallet with USDC and set GROW_AGENT_SECRET to the secretKey above. Then POST /api/grow/start. (Omit GROW_AGENT_SECRET to run free-lane only, no spend.)",
  }, { status: 201 });
}
