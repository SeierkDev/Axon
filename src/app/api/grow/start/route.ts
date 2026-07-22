import { NextRequest, NextResponse } from "next/server";
import { createGrowRun, getActiveGrowRun, recordGrowEvent, updateGrowRun } from "@/lib/grow";
import { buildGrowDeps } from "@/lib/growWiring";
import { runGrowMission } from "@/lib/growRunner";
import { getBudget } from "@/lib/budgets";

export const dynamic = "force-dynamic";

// Kick off a grow-yourself run. Guarded by GROW_SECRET; the entrepreneur's identity
// (GROW_AGENT_ID) and its API key (GROW_AGENT_KEY) come from env so the key never
// travels in the request. Returns the runId immediately and runs the mission in the
// background — the /experiment page polls the live timeline from there.
export async function POST(req: NextRequest) {
  const secret = process.env.GROW_SECRET;
  const provided = req.headers.get("x-grow-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const self = process.env.GROW_AGENT_ID;
  const apiKey = process.env.GROW_AGENT_KEY;
  if (!self || !apiKey) {
    return NextResponse.json({ error: "GROW_AGENT_ID / GROW_AGENT_KEY not configured" }, { status: 500 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    mission?: string; budgetUsdc?: number; perHireCapUsdc?: number; maxHires?: number; baseUrl?: string;
  };
  const mission = body.mission?.trim();
  if (!mission) return NextResponse.json({ error: "mission is required" }, { status: 400 });

  // One run at a time per agent: overlapping runs would race the shared daily budget
  // cap, and on the pay-first on-chain path the loser pays then gets rejected (funds
  // lost). Block a new run while one is still in progress.
  const active = getActiveGrowRun(self);
  if (active) {
    return NextResponse.json({ error: "a run is already in progress", runId: active.runId }, { status: 409 });
  }

  let budgetUsdc = body.budgetUsdc ?? 20;
  let perHireCapUsdc = body.perHireCapUsdc ?? 4;
  const maxHires = body.maxHires ?? 6;
  if (!(budgetUsdc > 0) || !(perHireCapUsdc > 0) || !(maxHires > 0)) {
    return NextResponse.json({ error: "budgetUsdc, perHireCapUsdc and maxHires must be positive" }, { status: 400 });
  }

  // Clamp the run's SOFT caps to the agent's HARD on-chain budget cap. Without this,
  // a request could authorize a hire above the payment-layer cap; on the pay-first
  // on-chain path that pays, then checkBudget rejects the task — losing the funds.
  const budget = getBudget(self);
  if (budget) {
    if (budget.maxPerCallUsdc != null) perHireCapUsdc = Math.min(perHireCapUsdc, budget.maxPerCallUsdc);
    const dayCeiling = budget.remainingTodayUsdc ?? budget.maxPerDayUsdc;
    if (dayCeiling != null) budgetUsdc = Math.min(budgetUsdc, dayCeiling);
  }

  const run = createGrowRun({ agentId: self, mission, budgetUsdc });
  // GROW_AGENT_SECRET (the wallet's base64 secret) switches priced hires to the
  // on-chain path — the agent pays specialists directly from its own funded wallet.
  const deps = buildGrowDeps({ self, apiKey, baseUrl: body.baseUrl, walletSecret: process.env.GROW_AGENT_SECRET });

  // Fire-and-forget: run the mission in the background, keep serving. Any uncaught
  // crash is recorded and the run marked failed — never left silently hanging.
  void runGrowMission(deps, { mission, budgetUsdc, perHireCapUsdc, maxHires }, run.runId).catch((e) => {
    try {
      recordGrowEvent(run.runId, { kind: "error", summary: `Run crashed: ${(e as Error).message}` });
      updateGrowRun(run.runId, { status: "failed" });
    } catch { /* best-effort */ }
  });

  return NextResponse.json({ runId: run.runId, mission, budgetUsdc, perHireCapUsdc, maxHires }, { status: 202 });
}
