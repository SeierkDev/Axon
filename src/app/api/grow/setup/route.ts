import { NextRequest, NextResponse } from "next/server";
import { createAgent, getAgentById } from "@/lib/agents";
import { generateKeyPair, createApiKey } from "@/lib/identity";
import { createBudget } from "@/lib/budgets";
import type { Agent } from "@/sdk/types";

export const dynamic = "force-dynamic";

// One-time bootstrap for the grow experiment (guarded by GROW_SECRET): creates the
// entrepreneur's identity + a real wallet, sets a HARD budget cap (enforced
// on every payment), and mints its API key. The apiKey + secretKey are returned
// ONCE — save them as GROW_AGENT_ID / GROW_AGENT_KEY (+ the wallet to fund with ETH).
export async function POST(req: NextRequest) {
  const secret = process.env.GROW_SECRET;
  const provided = req.headers.get("x-grow-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    agentId?: string; name?: string; provider?: Agent["provider"];
    budgetEth?: number; perHireCapEth?: number;
  };
  const agentId = (body.agentId ?? "the-entrepreneur").trim();
  const budgetEth = body.budgetEth ?? 20;
  const perHireCapEth = body.perHireCapEth ?? 4;

  if (getAgentById(agentId)) {
    return NextResponse.json({ error: `agent "${agentId}" already exists, delete it first or pick another agentId` }, { status: 409 });
  }

  // A real wallet on this chain: fund it for the on-chain path later. Ownership of the agent is
  // tied to this address, so its API key can authorize its own hires.
  const { address: walletAddress, privateKey } = generateKeyPair();

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
  createBudget({ agentId, name: "grow experiment", maxPerCallEth: perHireCapEth, maxPerDayEth: budgetEth });

  return NextResponse.json({
    agentId,
    walletAddress,
    apiKey,        // set as GROW_AGENT_KEY (shown once)
    privateKey,    // the wallet's key, save it to fund and sign on-chain later (shown once)
    budget: { perHireCapEth, maxPerDayEth: budgetEth },
    next: "Set GROW_AGENT_ID + GROW_AGENT_KEY in env. For the on-chain paid path, fund the wallet with ETH and set GROW_AGENT_SECRET to the secretKey above. Then POST /api/grow/start. (Omit GROW_AGENT_SECRET to run free-lane only, no spend.)",
  }, { status: 201 });
}
