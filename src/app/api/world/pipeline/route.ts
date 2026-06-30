import { NextRequest, NextResponse } from "next/server";
import { createWorkflow, getWorkflow } from "@/lib/workflows";
import { getAgentById } from "@/lib/agents";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, refundRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// Walk-the-pipeline: a visitor assembles a REAL multi-agent workflow by
// visiting houses, then runs it from the plaza pipeline desk. The chain
// executes through the actual workflow machinery — each step's output becomes
// the next agent's input — as a free showcase run (short, capped, rate-limited)
// with the same live task activity every other surface shows.

const WORLD_REQUESTER = "axon-world-visitor";
const MAX_STEPS = 3;
const MAX_TASK_CHARS = 240;
// Per IP per hour — showcase, not a free compute faucet. Overridable via env
// so filming/testing days don't need a redeploy to change the cap.
const RUN_LIMIT = Math.max(1, Number(process.env.WORLD_PIPELINE_RUN_LIMIT) || 4);
const RUN_WINDOW_MS = 60 * 60 * 1000;
const POLL_LIMIT = 60;
const POLL_WINDOW_MS = 60_000;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rlKey = `world-pipeline:${ip}`;
  const rl = checkRateLimit(rlKey, RUN_LIMIT, RUN_WINDOW_MS);
  if (!rl.allowed) {
    // A blocked attempt is not a run — refund the increment, or retrying while
    // blocked inflates the count far past the limit and a raised cap never helps.
    refundRateLimit(rlKey);
    return tooManyRequests(rl);
  }
  // The hourly cap counts pipelines that RUN. A rejected request hands the
  // slot back — otherwise two failed attempts lock a visitor out for an hour.
  const fail = (code: Parameters<typeof apiError>[0], msg: string, status: number) => {
    refundRateLimit(rlKey);
    return apiError(code, msg, status);
  };

  const body = (await req.json().catch(() => null)) as { agents?: string[]; task?: string } | null;
  const agents = Array.isArray(body?.agents) ? body.agents.filter((a) => typeof a === "string") : [];
  const task = typeof body?.task === "string" ? body.task.trim().slice(0, MAX_TASK_CHARS) : "";

  if (agents.length < 1 || agents.length > MAX_STEPS) {
    return fail("VALIDATION_ERROR", `Pipeline needs 1–${MAX_STEPS} agents`, 400);
  }
  if (new Set(agents).size !== agents.length) {
    return fail("VALIDATION_ERROR", "Each agent can appear only once in the pipeline", 400);
  }
  if (task.length < 10) {
    return fail("VALIDATION_ERROR", "Describe the job in at least 10 characters", 400);
  }
  for (const id of agents) {
    if (!getAgentById(id)) return fail("NOT_FOUND", `Agent '${id}' not found`, 404);
  }

  try {
    const wf = createWorkflow({ fromAgent: WORLD_REQUESTER, agents, task });
    logger.info("world.pipeline_started", "World pipeline started", {
      workflowId: wf.workflowId,
      agents: agents.join(" → "),
    });
    return NextResponse.json({ workflowId: wf.workflowId });
  } catch (err) {
    return fail("INTERNAL_ERROR", err instanceof Error ? err.message : "Pipeline failed to start", 500);
  }
}

// GET ?id=<workflowId> — live progress for a WORLD-STARTED pipeline only.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world-pipeline-poll:${ip}`, POLL_LIMIT, POLL_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const id = req.nextUrl.searchParams.get("id") ?? "";
  const wf = id ? getWorkflow(id) : null;
  // Only expose workflows the world itself created — the authed API owns the rest.
  if (!wf || wf.fromAgent !== WORLD_REQUESTER) {
    return apiError("NOT_FOUND", "Pipeline not found", 404);
  }

  return NextResponse.json({
    workflowId: wf.workflowId,
    status: wf.status,
    currentStep: wf.currentStep,
    agents: wf.agents,
    steps: wf.steps.map((s) => ({ toAgent: s.agentId, status: s.status })),
    // The FULL deliverable — a 1500-char display slice here spent days being
    // mistaken for model truncation. 24k is a payload bound, not a cut anyone
    // will ever see (step framing asks for ~800 words).
    finalOutput: wf.status === "completed" ? (wf.finalOutput ?? "").slice(0, 24_000) : undefined,
  });
}
