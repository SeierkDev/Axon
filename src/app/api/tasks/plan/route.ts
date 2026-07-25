import { NextRequest, NextResponse } from "next/server";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { parseBody, planTaskSchema } from "@/lib/schemas";
import { getAgentById } from "@/lib/agents";
import { getProvider } from "@/lib/providers";
import { planTeam, executePlan, type ThinkFn } from "@/lib/planner";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";

// Planning runs the agent's model — heavier than a normal task submit, so a
// tighter limit.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

const PLAN_SYSTEM =
  "You are an autonomous planning agent on the Axon marketplace. You reason concisely and produce concrete, usable output — no filler.";

export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handle(req));
}

// Phase 11 — the self-assembling planner. Give it a goal and a budget; it
// decomposes the goal, routes each step to the best worker, and returns the
// assembled team + projected cost. `execute: true` then creates the routed,
// balance-funded tasks. You approve a budget, not a plan.
async function handle(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`plan:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, planTaskSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // The planner spends the paying agent's balance and runs its model, so the
  // caller must own `from`.
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, body.from)) {
    return apiError("FORBIDDEN", "from must be an agent owned by your wallet", 403);
  }
  const me = getAgentById(body.from);
  if (!me) return apiError("NOT_FOUND", `Agent '${body.from}' not found`, 404);

  const think: ThinkFn = (prompt, opts) => getProvider(me).complete(PLAN_SYSTEM, prompt, opts?.maxTokens ?? 1200);

  let plan;
  try {
    plan = await planTeam(
      { from: body.from, goal: body.goal, budgetUsdc: body.budgetUsdc, maxSteps: body.maxSteps, perStepCapUsdc: body.perStepCapUsdc },
      think,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "planning failed";
    // Don't echo provider/config internals (missing keys, endpoints) to callers.
    const safe = /is not set|API_KEY|HELIUS|token|secret|endpoint/i.test(msg) ? "the planning model is temporarily unavailable" : msg;
    return apiError("EXECUTION_ERROR", `Planning failed: ${safe}`, 502);
  }

  if (plan.steps.length === 0) {
    return apiError("EXECUTION_ERROR", "Could not decompose the goal into steps", 422);
  }

  // Dry run (default): return the team + projected cost so the caller can approve
  // the budget before anything is hired.
  if (!body.execute) {
    return NextResponse.json({ plan, executed: false }, { headers: rateLimitHeaders(rl, RATE_LIMIT) });
  }

  if (plan.routedCount === 0) {
    return apiError("NO_AGENT_AVAILABLE", "No agents matched any step of the plan", 404);
  }
  const execution = executePlan(body.from, plan);
  return NextResponse.json({ plan, executed: true, execution }, { status: 201, headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
