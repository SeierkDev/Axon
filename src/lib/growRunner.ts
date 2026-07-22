// The "grow yourself" engine: a budgeted agent that plans a mission, hires proven
// specialists on Axon to do the parts, and assembles the result — recording every
// move to the public grow_events timeline. Pure orchestration: the LLM reasoning
// (`think`), discovery (`search`), and hiring (`hire`) are injected, so the engine
// is testable with fakes and spends nothing on its own. Budget is enforced here
// AND by the agent's on-chain budget cap (checkBudget) — defense in depth.
import {
  createGrowRun, getGrowRun, updateGrowRun, recordGrowEvent, getGrowSpent, type GrowRun,
} from "./grow";

export interface GrowCandidate {
  agentId: string;
  name: string;
  priceUsdc: number | null;   // null = free lane
  proofScore?: number;
  capabilities: string[];
}

export interface GrowHireOutcome {
  taskId: string;
  status: "completed" | "failed" | "timeout";
  output?: string;
  error?: string;
  costUsdc: number;
  receiptUrl?: string;
}

export interface GrowSubtask {
  capability: string;   // what kind of specialist to look for
  task: string;         // the instruction to hand the specialist
}

export interface GrowDeps {
  self: string;   // the entrepreneur's own agentId
  think: (prompt: string, opts?: { maxTokens?: number }) => Promise<string>;
  search: (q: { capability?: string; query?: string; maxPriceUsdc?: number; limit?: number }) => Promise<GrowCandidate[]>;
  hire: (o: { to: string; task: string; context?: string; priceUsdc: number }) => Promise<GrowHireOutcome>;
}

export interface GrowConfig {
  mission: string;
  budgetUsdc: number;
  perHireCapUsdc: number;
  maxHires: number;
}

const planPrompt = (mission: string, maxHires: number) =>
  `You are an autonomous agent with a real budget, hiring specialist AI agents on a marketplace to accomplish a mission. Break the mission into at most ${maxHires} concrete sub-tasks, each handled by one specialist.

Mission: ${mission}

Return ONLY a JSON array, no prose, each item: {"capability": "<one lowercase keyword for the kind of specialist, e.g. research, writing, analysis, summarization, fact-checking>", "task": "<a self-contained instruction for that specialist>"}. Order them so earlier results feed later ones.`;

const synthPrompt = (mission: string, parts: { task: string; output: string }[]) =>
  `You are an autonomous agent assembling the final deliverable for your mission from the work of specialists you hired.

Mission: ${mission}

The specialists returned:
${parts.map((p, i) => `--- Specialist ${i + 1} (${p.task}) ---\n${p.output}`).join("\n\n")}

Write the final deliverable now: a clear, well-structured, self-contained result that fulfills the mission. Do not mention that it was assembled from parts.`;

/** Pull the first JSON array out of a model response (tolerates code fences / prose). */
function parsePlan(text: string): GrowSubtask[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as unknown[];
    return arr
      .filter((x): x is GrowSubtask =>
        !!x && typeof (x as GrowSubtask).capability === "string" && typeof (x as GrowSubtask).task === "string")
      .map((x) => ({ capability: x.capability.trim().toLowerCase(), task: x.task.trim() }));
  } catch {
    return [];
  }
}

/** Best affordable specialist: highest Proof Score within the price ceiling, not self. */
function pickBest(candidates: GrowCandidate[], self: string, ceilingUsdc: number): GrowCandidate | null {
  const affordable = candidates
    .filter((c) => c.agentId !== self)
    .filter((c) => (c.priceUsdc ?? 0) <= ceilingUsdc)
    .sort((a, b) => (b.proofScore ?? 0) - (a.proofScore ?? 0));
  return affordable[0] ?? null;
}

export interface GrowResult {
  run: GrowRun;
  deliverable?: string;
  hires: number;
  spentUsdc: number;
}

/**
 * Run one grow-yourself mission end to end. Records a live timeline as it goes;
 * never throws for an individual hire failure (records it and continues). Stops
 * hiring when the budget can't cover another hire.
 */
export async function runGrowMission(deps: GrowDeps, cfg: GrowConfig, existingRunId?: string): Promise<GrowResult> {
  const run =
    (existingRunId ? getGrowRun(existingRunId) : null) ??
    createGrowRun({ agentId: deps.self, mission: cfg.mission, budgetUsdc: cfg.budgetUsdc });
  const { runId } = run;
  recordGrowEvent(runId, {
    kind: "note",
    summary: `Mission started.`,
    data: { budgetUsdc: cfg.budgetUsdc, perHireCapUsdc: cfg.perHireCapUsdc, maxHires: cfg.maxHires },
  });

  // 1. Plan
  let plan: GrowSubtask[] = [];
  try {
    const raw = await deps.think(planPrompt(cfg.mission, cfg.maxHires), { maxTokens: 1200 });
    plan = parsePlan(raw).slice(0, cfg.maxHires);
  } catch (e) {
    recordGrowEvent(runId, { kind: "error", summary: `Planning failed: ${(e as Error).message}` });
  }
  if (plan.length === 0) {
    updateGrowRun(runId, { status: "failed" });
    recordGrowEvent(runId, { kind: "error", summary: "Could not produce a plan — nothing to hire for." });
    return { run: { ...run, status: "failed" }, hires: 0, spentUsdc: 0 };
  }
  updateGrowRun(runId, { status: "hiring", plan });
  recordGrowEvent(runId, {
    kind: "plan",
    summary: `Planned ${plan.length} step${plan.length === 1 ? "" : "s"}: ${plan.map((p) => p.capability).join(", ")}.`,
    data: plan,
  });

  // 2. Hire a specialist per step, within budget
  const parts: { task: string; output: string }[] = [];
  let hires = 0;
  for (const step of plan) {
    const remaining = cfg.budgetUsdc - getGrowSpent(runId);
    const ceiling = Math.min(cfg.perHireCapUsdc, remaining);
    if (ceiling <= 0) {
      recordGrowEvent(runId, { kind: "note", summary: "Budget spent — stopping here." });
      break;
    }

    let candidates;
    try {
      candidates = await deps.search({ capability: step.capability, maxPriceUsdc: ceiling, limit: 10 });
    } catch (e) {
      recordGrowEvent(runId, { kind: "error", summary: `Search failed for "${step.capability}": ${(e as Error).message}` });
      continue;
    }
    recordGrowEvent(runId, {
      kind: "search",
      summary: `Searched for a "${step.capability}" specialist — ${candidates.length} found.`,
      data: { capability: step.capability, ceilingUsdc: ceiling, found: candidates.length },
    });

    const pick = pickBest(candidates, deps.self, ceiling);
    if (!pick) {
      recordGrowEvent(runId, { kind: "note", summary: `No affordable "${step.capability}" specialist — skipping this step.` });
      continue;
    }

    recordGrowEvent(runId, {
      kind: "hire",
      summary: `Hiring ${pick.name} (${pick.agentId})${pick.proofScore != null ? `, Proof Score ${pick.proofScore}` : ""} for "${step.capability}".`,
      toAgent: pick.agentId,
      amountUsdc: pick.priceUsdc ?? 0,
      data: { capability: step.capability, priceUsdc: pick.priceUsdc, proofScore: pick.proofScore },
    });

    try {
      const outcome = await deps.hire({ to: pick.agentId, task: step.task, priceUsdc: pick.priceUsdc ?? 0 });
      // Always log money that actually moved — whether the specialist then returned
      // nothing or the hire timed out with funds committed — so the timeline and
      // getGrowSpent never miss a real payment.
      if (outcome.costUsdc > 0) {
        recordGrowEvent(runId, {
          kind: "payment",
          summary: `Paid ${pick.name}${outcome.status === "completed" ? "" : ` (task ${outcome.status})`}.`,
          taskId: outcome.taskId, toAgent: pick.agentId, amountUsdc: outcome.costUsdc,
        });
      }
      if (outcome.status === "completed" && outcome.output) {
        recordGrowEvent(runId, {
          kind: "result",
          summary: `${pick.name} delivered "${step.capability}".`,
          taskId: outcome.taskId, toAgent: pick.agentId,
          data: { receiptUrl: outcome.receiptUrl, preview: outcome.output.slice(0, 280) },
        });
        parts.push({ task: step.task, output: outcome.output });
        hires++;
      } else if (outcome.status === "completed") {
        recordGrowEvent(runId, {
          kind: "error",
          summary: `${pick.name} completed but returned nothing usable.`,
          taskId: outcome.taskId, toAgent: pick.agentId,
        });
      } else {
        recordGrowEvent(runId, {
          kind: "error",
          summary: `${pick.name} didn't deliver (${outcome.status})${outcome.error ? `: ${outcome.error}` : ""}.`,
          taskId: outcome.taskId, toAgent: pick.agentId,
        });
      }
    } catch (e) {
      recordGrowEvent(runId, { kind: "error", summary: `Hire failed: ${(e as Error).message}`, toAgent: pick.agentId });
    }
  }

  // 3. Synthesize the deliverable
  let deliverable: string | undefined;
  if (parts.length > 0) {
    updateGrowRun(runId, { status: "synthesizing" });
    try {
      deliverable = (await deps.think(synthPrompt(cfg.mission, parts), { maxTokens: 3000 })).trim();
      recordGrowEvent(runId, { kind: "synthesis", summary: `Assembled the final deliverable from ${parts.length} specialist result${parts.length === 1 ? "" : "s"}.` });
    } catch (e) {
      recordGrowEvent(runId, { kind: "error", summary: `Synthesis failed: ${(e as Error).message}` });
    }
  }

  const spentUsdc = getGrowSpent(runId);
  const finalStatus = deliverable ? "completed" : "failed";
  updateGrowRun(runId, { status: finalStatus, deliverable });
  recordGrowEvent(runId, {
    kind: "note",
    summary: deliverable
      ? `Mission complete — ${hires} hire${hires === 1 ? "" : "s"}.`
      : `Mission ended without a deliverable — ${hires} hire${hires === 1 ? "" : "s"}.`,
  });

  return { run: { ...run, status: finalStatus, deliverable }, deliverable, hires, spentUsdc };
}
