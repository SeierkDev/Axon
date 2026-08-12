import { NextRequest, NextResponse } from "next/server";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { getBearerToken } from "@/lib/identity";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";
import { recordAuditEvent } from "@/lib/audit";
import { getAgentById } from "@/lib/agents";
import { getBudget } from "@/lib/budgets";
import {
  createGrowRun, getActiveGrowRun, listGrowRunsForOwner, recordGrowEvent, updateGrowRun,
} from "@/lib/grow";
import { buildGrowDeps } from "@/lib/growWiring";
import { runGrowMission, previewGrowMission } from "@/lib/growRunner";
import { growMissionSchema, parseBody } from "@/lib/schemas";
import { getMissionTemplate } from "@/lib/missionTemplates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Missions — grow-yourself for everyone.
//
// Give an agent you own a budget and a mission: it plans the work, finds proven
// specialists on the marketplace, hires and pays them, and assembles the result.
// Every step lands on a timeline, and every hire has a public receipt.
//
// NON-CUSTODIAL BY CONSTRUCTION. The platform's own experiment can be handed a
// wallet secret via env to pay on-chain; a user's mission never can. Priced
// hires here draw on the agent's EARNED BALANCE, and free-lane hires cost
// nothing — so running a mission cannot spend anything the agent has not already
// made, and Axon never holds anybody's key.

/** GET /api/grow/runs — your missions. */
export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 20, 1), 100);
  return NextResponse.json({ runs: listGrowRunsForOwner(auth.user.walletAddress, limit) });
}

/** POST /api/grow/runs — start one. */
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    // A mission is a burst of real work — planning, discovery, and up to `maxHires`
    // paid tasks. Rate-limited per owner so one key can't stampede the marketplace.
    const rl = checkRateLimit(`grow-mission:${auth.user.walletAddress}`, 6, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const parsed = parseBody(await req.json().catch(() => null), growMissionSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const agent = getAgentById(body.agentId);
    if (!agent) return apiError("NOT_FOUND", `Agent '${body.agentId}' not found`, 404);
    if (!canAccessIdentity(auth.user, body.agentId)) {
      return apiError("FORBIDDEN", "You do not own this agent", 403);
    }

    // One at a time per agent: two runs would race the same daily budget cap and
    // the same earned balance, and the loser can pay before being rejected. A dry
    // run creates nothing and spends nothing, so it is never blocked — you should
    // always be able to ask what a mission would cost.
    const active = body.dryRun ? null : getActiveGrowRun(body.agentId);
    if (active) {
      return apiError("CONFLICT", "This agent already has a mission running", 409, { runId: active.runId });
    }

    // The agent's own budget caps are the hard ceiling — a mission can ask for
    // less, never more. Without this a request could authorise a hire above the
    // payment layer's cap, which pays and is then rejected.
    let budgetUsdc = body.budgetUsdc;
    let perHireCapUsdc = body.perHireCapUsdc ?? Math.min(4, body.budgetUsdc);
    const maxHires = body.maxHires ?? 6;
    const budget = getBudget(body.agentId);
    if (budget) {
      if (budget.maxPerCallUsdc != null) perHireCapUsdc = Math.min(perHireCapUsdc, budget.maxPerCallUsdc);
      const dayCeiling = budget.remainingTodayUsdc ?? budget.maxPerDayUsdc;
      if (dayCeiling != null) budgetUsdc = Math.min(budgetUsdc, dayCeiling);
    }
    if (!(budgetUsdc > 0) || !(perHireCapUsdc > 0)) {
      return apiError(
        "VALIDATION_ERROR",
        "This agent's budget caps leave nothing to spend, raise them, or the mission has no room to hire",
        400,
      );
    }

    // The mission hires through the public API as an ordinary client, so it needs
    // the caller's own key. No walletSecret — see the note at the top; priced
    // hires spend the agent's earned balance.
    const apiKey = getBearerToken(req);
    if (!apiKey) return apiError("AUTH_REQUIRED", "Missing API key", 401);
    const deps = buildGrowDeps({ self: body.agentId, apiKey });

    // A dry run plans and prices the work and stops there. Spending is the one
    // thing you can't undo, so seeing what it intends to do — and what that
    // would cost — shouldn't require committing to it first.
    if (body.dryRun) {
      try {
        const preview = await previewGrowMission(deps, { mission: body.mission, budgetUsdc, perHireCapUsdc, maxHires });
        return NextResponse.json({ dryRun: true, budgetUsdc, perHireCapUsdc, maxHires, ...preview });
      } catch (err) {
        // Planning runs the agent's own model. A real run records that failure on
        // its timeline; a preview has no timeline to record it on, so say what
        // went wrong instead of throwing a bare 500 at the caller.
        return apiError(
          "UPSTREAM_ERROR",
          `Could not plan the mission, ${err instanceof Error ? err.message : "the agent's model did not respond"}`,
          502,
        );
      }
    }

    // Only record a template id we actually recognise — an unknown one would
    // put a dead "run this yourself" link on a published page.
    const templateId = getMissionTemplate(body.templateId)?.id;

    const run = createGrowRun({
      agentId: body.agentId,
      ownerWallet: auth.user.walletAddress,
      mission: body.mission,
      budgetUsdc,
      perHireCapUsdc,
      maxHires,
      templateId,
    });

    recordAuditEvent({
      req, actor: auth.user, action: "grow.mission_started",
      resourceType: "grow_run", resourceId: run.runId,
      ownerAgentId: body.agentId, ownerWallet: auth.user.walletAddress,
      metadata: { budgetUsdc, perHireCapUsdc, maxHires },
    });

    // Fire-and-forget: the mission runs in the background and the caller polls the
    // timeline. A crash is recorded and the run marked failed, never left hanging.
    void runGrowMission(deps, { mission: body.mission, budgetUsdc, perHireCapUsdc, maxHires }, run.runId)
      .catch((e) => {
        try {
          recordGrowEvent(run.runId, { kind: "error", summary: `Run crashed: ${(e as Error).message}` });
          updateGrowRun(run.runId, { status: "failed" });
        } catch { /* best-effort */ }
      });

    return NextResponse.json(
      { runId: run.runId, agentId: body.agentId, mission: body.mission, budgetUsdc, perHireCapUsdc, maxHires },
      { status: 202 },
    );
  });
}
