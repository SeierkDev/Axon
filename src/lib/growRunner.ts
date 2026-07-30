// The "grow yourself" engine: a budgeted agent that plans a mission, hires proven
// specialists on Axon to do the parts, and assembles the result — recording every
// move to the public grow_events timeline. Pure orchestration: the LLM reasoning
// (`think`), discovery (`search`), and hiring (`hire`) are injected, so the engine
// is testable with fakes and spends nothing on its own. Budget is enforced here
// AND by the agent's on-chain budget cap (checkBudget) — defense in depth.
import {
  createGrowRun, getGrowRun, getGrowEvents, updateGrowRun, recordGrowEvent, getGrowSpent,
  isGrowRunCanceled, type GrowRun,
} from "./grow";
import { buildMissionManifest } from "./growReceipt";

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
  /**
   * 1-based indices of the steps whose output this one needs.
   *
   * Steps with nothing outstanding run at the same time. Without this every
   * mission is as slow as the sum of its parts even when the parts have nothing
   * to do with each other.
   */
  needs?: number[];
}

export interface GrowDeps {
  self: string;   // the entrepreneur's own agentId
  think: (prompt: string, opts?: { maxTokens?: number }) => Promise<string>;
  /**
   * Re-read a finished hire's full output.
   *
   * The timeline only keeps a short preview, so recovering a mission that died
   * mid-flight means going back to the tasks themselves — which still hold the
   * whole thing.
   */
  fetchOutput?: (taskId: string) => Promise<string | null>;
  /**
   * Do a step itself, using whatever tools it has been granted.
   *
   * The last resort, only when nobody could be hired for it. Losing a step
   * because the marketplace happens to be thin in that capability is worse than
   * the agent having a go — but this is unhired, unpaid, and unwitnessed work,
   * so the timeline has to say so rather than passing it off as a hire.
   */
  attempt?: (task: string, context?: string) => Promise<string>;
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

Return ONLY a JSON array, no prose, each item: {"capability": "<one lowercase keyword for the kind of specialist, e.g. research, writing, analysis, summarization, fact-checking>", "task": "<a self-contained instruction for that specialist>", "needs": [<1-based numbers of the steps whose output this one actually requires, [] if none>]}.

Be honest about "needs": only list a step you genuinely cannot start without. Steps that need nothing from each other are run at the same time, so an unnecessary dependency just makes the mission slower.`;

const synthPrompt = (mission: string, parts: { task: string; output: string }[]) =>
  `You are an autonomous agent assembling the final deliverable for your mission from the work of specialists you hired.

Mission: ${mission}

The specialists returned:
${parts.map((p, i) => `--- Specialist ${i + 1} (${p.task}) ---\n${p.output}`).join("\n\n")}

Write the final deliverable now: a clear, well-structured, self-contained result that fulfills the mission. Do not mention that it was assembled from parts.`;

const reviewPrompt = (task: string, output: string) =>
  `You commissioned this work from a specialist and you are about to put it in front of the person who paid for it. Judge whether it actually does the job.

What you asked for: ${task}

What came back:
${output.slice(0, 6000)}

Return ONLY JSON: {"ok": true|false, "reason": "<one short sentence>"}. Mark it not-ok only if it is off-topic, empty, refuses the task, or is too thin to use — not merely because you would have written it differently.`;

const replanPrompt = (mission: string, done: { task: string; output: string }[], remaining: GrowSubtask[]) =>
  `You are partway through a mission and deciding what is still worth doing.

Mission: ${mission}

Work already completed:
${done.length ? done.map((d, i) => `--- ${i + 1} (${d.task}) ---\n${d.output.slice(0, 800)}`).join("\n\n") : "(nothing yet — the steps so far produced nothing usable)"}

Steps still planned:
${remaining.map((r, i) => `${i + 1}. [${r.capability}] ${r.task}`).join("\n")}

Revise the remaining steps in light of what actually came back — drop what is now redundant or impossible, reword what the earlier results changed, keep what still holds. Reply with ONLY the revised remaining steps as a JSON array, same shape as before: {"capability": "<lowercase keyword>", "task": "<self-contained instruction>"}. Do NOT include steps that are already done. Return them unchanged if nothing needs to change.`;

/** How many times a mission may revise its own plan. Bounded so it converges. */
const MAX_REPLANS = 2;

/** The reviewer's verdict on a specialist's output. Unparseable = accept. */
function parseReview(text: string): { ok: boolean; reason: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ok: true, reason: "" };
  try {
    const v = JSON.parse(m[0]) as { ok?: unknown; reason?: unknown };
    // Only a clear "false" rejects. A reviewer that answers in a shape we don't
    // understand must not be able to throw away work somebody paid for.
    return { ok: v.ok !== false, reason: typeof v.reason === "string" ? v.reason : "" };
  } catch {
    return { ok: true, reason: "" };
  }
}

/** Pull the first JSON array out of a model response (tolerates code fences / prose). */
function parsePlan(text: string): GrowSubtask[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as unknown[];
    return arr
      .filter((x): x is GrowSubtask =>
        !!x && typeof (x as GrowSubtask).capability === "string" && typeof (x as GrowSubtask).task === "string")
      .map((x, i) => ({
        capability: x.capability.trim().toLowerCase(),
        task: x.task.trim(),
        // Absence of information is not evidence of independence. A model that
        // simply omits "needs" gets the old sequential behaviour — every earlier
        // step — because running dependent steps together would strip the very
        // context that makes an ordered plan work. Parallelism is opt-in, by the
        // plan explicitly saying a step needs nothing.
        //
        // Only backward references count either way: a step claiming to need
        // itself, or something later, would deadlock the scheduler.
        needs: Array.isArray(x.needs)
          ? x.needs.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= i)
          : Array.from({ length: i }, (_, k) => k + 1),
      }));
  } catch {
    return [];
  }
}

/**
 * How close on Proof Score counts as "just as good".
 *
 * Ranking on score alone spends the whole budget on the top of the list: a
 * 910-rated specialist at 4 USDC beats an 890-rated one at 0.40, so the mission
 * buys one step instead of five. Within this margin the two are not meaningfully
 * different in proven quality, so price decides — which is what makes the same
 * budget stretch across a plan.
 */
const SCORE_MARGIN = 0.05;

/**
 * Affordable specialists in the order they should be tried.
 *
 * Anything within SCORE_MARGIN of the best available score is treated as equal
 * quality and ordered cheapest first; everything below that margin follows,
 * still by score. So value wins among equals, but a genuinely better specialist
 * is never passed over for a cheap one.
 */
function rankAffordable(candidates: GrowCandidate[], self: string, ceilingUsdc: number): GrowCandidate[] {
  const affordable = candidates
    .filter((c) => c.agentId !== self)
    .filter((c) => (c.priceUsdc ?? 0) <= ceilingUsdc);
  if (affordable.length === 0) return [];

  const best = Math.max(...affordable.map((c) => c.proofScore ?? 0));
  const threshold = best * (1 - SCORE_MARGIN);
  const equals = affordable.filter((c) => (c.proofScore ?? 0) >= threshold);
  const rest = affordable.filter((c) => (c.proofScore ?? 0) < threshold);

  return [
    // Cheapest of the ones that are as good as it gets; score breaks a price tie.
    ...equals.sort((a, b) => (a.priceUsdc ?? 0) - (b.priceUsdc ?? 0) || (b.proofScore ?? 0) - (a.proofScore ?? 0)),
    ...rest.sort((a, b) => (b.proofScore ?? 0) - (a.proofScore ?? 0)),
  ];
}

/** How many specialists a single step may try before it gives up. */
const ATTEMPTS_PER_STEP = 3;
/** Ceiling on parallel hires — enough to feel fast, not enough to stampede. */
const MAX_CONCURRENT_HIRES = 4;
/** How much earlier work to hand forward, so the context stays affordable. */
const CONTEXT_STEPS = 3, CONTEXT_CHARS = 1400;

/**
 * What the specialists before this one produced.
 *
 * The planner is asked to order steps so earlier results feed later ones — which
 * only means anything if the later specialist can actually see them. Bounded on
 * both ends: the last few results, each truncated, so a long mission cannot
 * inflate one hire's prompt without limit.
 */
function priorContext(parts: { task: string; output: string }[]): string | undefined {
  if (parts.length === 0) return undefined;
  return parts
    .slice(-CONTEXT_STEPS)
    .map((p, i) => `--- Earlier result ${i + 1} (${p.task}) ---\n${p.output.slice(0, CONTEXT_CHARS)}`)
    .join("\n\n");
}

export interface GrowPreviewStep {
  capability: string;
  task: string;
  /** The specialist it would hire, or null if nothing affordable was found. */
  pick: { agentId: string; name: string; priceUsdc: number; proofScore?: number } | null;
  alternatives: number;
}

export interface GrowPreview {
  plan: GrowSubtask[];
  steps: GrowPreviewStep[];
  estimatedUsdc: number;
  withinBudget: boolean;
}

/**
 * Plan a mission and price it, without hiring anybody.
 *
 * Spending is the one thing you cannot take back, so it should be possible to
 * see exactly what an agent intends to do — and what it would cost — before a
 * single hire happens. This runs the same planner and the same discovery as a
 * real run, then stops.
 */
export async function previewGrowMission(deps: GrowDeps, cfg: GrowConfig): Promise<GrowPreview> {
  const raw = await deps.think(planPrompt(cfg.mission, cfg.maxHires), { maxTokens: 1200 });
  const plan = parsePlan(raw).slice(0, cfg.maxHires);

  const steps: GrowPreviewStep[] = [];
  let estimatedUsdc = 0;
  for (const step of plan) {
    // Price each step against what is still notionally left, exactly as the real
    // run would — so a preview can't promise a hire the budget wouldn't reach.
    const ceiling = Math.min(cfg.perHireCapUsdc, Math.max(0, cfg.budgetUsdc - estimatedUsdc));
    let ranked: GrowCandidate[] = [];
    if (ceiling > 0) {
      try {
        ranked = rankAffordable(await deps.search({ capability: step.capability, maxPriceUsdc: ceiling, limit: 10 }), deps.self, ceiling);
      } catch {
        ranked = []; // discovery hiccup — report the step as unfilled rather than failing the preview
      }
    }
    const best = ranked[0];
    if (best) estimatedUsdc += best.priceUsdc ?? 0;
    steps.push({
      capability: step.capability,
      task: step.task,
      pick: best ? { agentId: best.agentId, name: best.name, priceUsdc: best.priceUsdc ?? 0, proofScore: best.proofScore } : null,
      alternatives: Math.max(0, ranked.length - 1),
    });
  }

  estimatedUsdc = Math.round(estimatedUsdc * 10000) / 10000;
  return { plan, steps, estimatedUsdc, withinBudget: estimatedUsdc <= cfg.budgetUsdc };
}

export interface GrowResult {
  run: GrowRun;
  deliverable?: string;
  hires: number;
  /** Steps the agent did itself because nobody could be hired — unpaid, unwitnessed. */
  selfDone: number;
  spentUsdc: number;
}


/**
 * Seal the mission receipt.
 *
 * Done once the run is terminal, from the timeline as it actually turned out —
 * so the manifest describes what happened rather than what was planned. Best
 * effort: a mission that produced a deliverable must not be marked failed
 * because the paperwork couldn't be written.
 */
async function sealManifest(
  deps: GrowDeps,
  runId: string,
  deliverable: string | undefined,
): Promise<void> {
  try {
    const run = getGrowRun(runId);
    if (!run) return;
    const events = getGrowEvents(runId);

    // The timeline keeps a 280-char preview; hashing that would pin something
    // nobody can reproduce. Re-read the real outputs so the hashes mean
    // something, and leave a step's hash null rather than claim a false one.
    const outputs = new Map<string, string>();
    if (deps.fetchOutput) {
      for (const ev of events) {
        if (ev.kind !== "result" || !ev.taskId) continue;
        try {
          const full = await deps.fetchOutput(ev.taskId);
          if (full) outputs.set(ev.taskId, full);
        } catch { /* a step without a recoverable output gets a null hash */ }
      }
    }

    const manifest = buildMissionManifest(run, events, { deliverable, outputs });
    updateGrowRun(runId, { manifest });
    recordGrowEvent(runId, {
      kind: "note",
      summary: `Mission receipt sealed — ${manifest.entries.length} step${manifest.entries.length === 1 ? "" : "s"}, chain hash ${manifest.hash.slice(0, 12)}…`,
      data: { manifestHash: manifest.hash },
    });
  } catch (e) {
    recordGrowEvent(runId, { kind: "error", summary: `Could not seal the mission receipt: ${(e as Error).message}` });
  }
}

/**
 * Finish a mission that died before it could.
 *
 * A deploy or a crash leaves a run non-terminal forever: the hires it already
 * paid for are orphaned and no deliverable is ever assembled, so the owner paid
 * and got nothing. Everything needed to recover is still on record — each result
 * event carries its taskId, and the task keeps the full output — so the work can
 * be re-gathered and the deliverable built from what was actually bought.
 *
 * Deliberately does NOT hire anything new. Resuming should recover value, never
 * spend more of somebody's money without them asking again.
 */
export async function resumeGrowMission(deps: GrowDeps, runId: string): Promise<GrowResult | null> {
  const run = getGrowRun(runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "failed") return null;

  const events = getGrowEvents(runId);
  const results = events.filter((e) => e.kind === "result" && e.taskId);
  recordGrowEvent(runId, {
    kind: "note",
    summary: `Picking this mission back up — recovering ${results.length} piece${results.length === 1 ? "" : "s"} of work already paid for.`,
  });

  // Re-gather the outputs. A step whose task can no longer be read is skipped
  // rather than failing the recovery: partial recovery beats none.
  const parts: { task: string; output: string }[] = [];
  for (const ev of results) {
    let output: string | null = null;
    if (deps.fetchOutput) {
      try {
        output = await deps.fetchOutput(ev.taskId!);
      } catch {
        output = null;
      }
    }
    if (!output) {
      // Fall back to the preview the timeline kept — thin, but better than
      // dropping a step the owner paid for.
      const preview = (ev.data as { preview?: string } | undefined)?.preview;
      if (!preview) {
        recordGrowEvent(runId, { kind: "error", summary: `Couldn't recover the work from ${ev.taskId} — leaving it out.` });
        continue;
      }
      output = preview;
    }
    parts.push({ task: ev.summary, output });
  }

  if (parts.length === 0) {
    updateGrowRun(runId, { status: "failed" });
    recordGrowEvent(runId, { kind: "note", summary: "Nothing recoverable — no completed work to assemble." });
    return { run: { ...run, status: "failed" }, hires: 0, selfDone: 0, spentUsdc: getGrowSpent(runId) };
  }

  updateGrowRun(runId, { status: "synthesizing" });
  let deliverable: string | undefined;
  try {
    deliverable = (await deps.think(synthPrompt(run.mission, parts), { maxTokens: 3000 })).trim();
    recordGrowEvent(runId, {
      kind: "synthesis",
      summary: `Assembled the deliverable from ${parts.length} recovered result${parts.length === 1 ? "" : "s"}.`,
    });
  } catch (e) {
    recordGrowEvent(runId, { kind: "error", summary: `Synthesis failed on resume: ${(e as Error).message}` });
  }

  const spentUsdc = getGrowSpent(runId);
  const status = deliverable ? "completed" : "failed";
  updateGrowRun(runId, { status, deliverable });
  await sealManifest(deps, runId, deliverable);
  recordGrowEvent(runId, {
    kind: "note",
    summary: deliverable
      ? `Recovered — deliverable built from ${parts.length} paid piece${parts.length === 1 ? "" : "s"}, ${spentUsdc} USDC already spent.`
      : `Could not recover a deliverable — ${spentUsdc} USDC was already spent.`,
  });
  return { run: { ...run, status, deliverable }, deliverable, hires: parts.length, selfDone: 0, spentUsdc };
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
    return { run: { ...run, status: "failed" }, hires: 0, selfDone: 0, spentUsdc: 0 };
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
  let stopped = false;
  let selfDone = 0;
  // A queue, not a fixed list: the mission is allowed to revise what's left of
  // its own plan once it has seen what the earlier steps actually produced.
  const queue: GrowSubtask[] = [...plan];
  let replans = 0;

  /**
   * The most hires that may run at once.
   *
   * Budget safety without needing prices up front: no single hire can exceed
   * perHireCapUsdc, so N concurrent hires can spend at most N × cap. Cap N at
   * what the remaining budget covers and even the worst case stays inside it —
   * which matters because concurrent hires all read "spent so far" before any of
   * them has finished paying, so a naive check would let them all through.
   */
  const concurrencyFor = (remaining: number) =>
    Math.max(1, Math.min(MAX_CONCURRENT_HIRES, Math.floor(remaining / cfg.perHireCapUsdc)));

  // Work through the plan in waves: everything whose dependencies are already
  // satisfied goes at once.
  const doneIdx = new Set<number>();
  const planIdx = new Map<GrowSubtask, number>();
  queue.forEach((st, i) => planIdx.set(st, i + 1));

  while (queue.length > 0 && hires + selfDone < cfg.maxHires) {
    if (isGrowRunCanceled(runId)) {
      recordGrowEvent(runId, { kind: "note", summary: "Stopped by the owner — no further hires." });
      stopped = true;
      break;
    }
    const remainingBudget = cfg.budgetUsdc - getGrowSpent(runId);
    if (remainingBudget <= 0) {
      recordGrowEvent(runId, { kind: "note", summary: "Budget spent — stopping here." });
      break;
    }

    // Ready = every step it declared a need on has already produced something.
    // A step whose dependency failed is still ready: it just gets less context.
    const ready = queue.filter((st) => (st.needs ?? []).every((n) => doneIdx.has(n) || !planIdx.has(queue[n - 1] ?? st)));
    const wave = (ready.length > 0 ? ready : [queue[0]]).slice(
      0,
      Math.min(concurrencyFor(remainingBudget), cfg.maxHires - hires - selfDone),
    );
    for (const st of wave) queue.splice(queue.indexOf(st), 1);

    if (wave.length > 1) {
      recordGrowEvent(runId, {
        kind: "note",
        summary: `Running ${wave.length} independent steps at once: ${wave.map((w) => w.capability).join(", ")}.`,
      });
    }

    // The context each step sees is fixed BEFORE the wave starts, so two steps
    // running together can't see half of each other's output and produce
    // different results depending on which finished first.
    const contextAtWaveStart = priorContext(parts);
    const results = await Promise.all(wave.map((st) => runStep(st, contextAtWaveStart)));
    results.forEach((r, i) => {
      if (r) doneIdx.add(planIdx.get(wave[i]) ?? -1);
    });
    if (stopped) break;
    await maybeReplan();
  }

  /**
   * One step, start to finish: find who can do it, hire down the ranking until
   * somebody delivers, judge the result. Returns whether it produced anything.
   */
  async function runStep(step: GrowSubtask, contextOverride?: string): Promise<boolean> {
    const remaining = cfg.budgetUsdc - getGrowSpent(runId);
    const ceiling = Math.min(cfg.perHireCapUsdc, remaining);
    if (ceiling <= 0) return false;

    let candidates;
    try {
      candidates = await deps.search({ capability: step.capability, maxPriceUsdc: ceiling, limit: 10 });
    } catch (e) {
      recordGrowEvent(runId, { kind: "error", summary: `Search failed for "${step.capability}": ${(e as Error).message}` });
      return false;
    }
    recordGrowEvent(runId, {
      kind: "search",
      summary: `Searched for a "${step.capability}" specialist — ${candidates.length} found.`,
      data: { capability: step.capability, ceilingUsdc: ceiling, found: candidates.length },
    });

    const ranked = rankAffordable(candidates, deps.self, ceiling);
    // If the pick isn't the highest-scored option, the owner should be able to see
    // that it was a value call rather than wonder why the best one was skipped.
    const topScore = Math.max(0, ...candidates.map((c) => c.proofScore ?? 0));
    if (ranked.length === 0) {
      // Nobody to hire. Rather than lose the step, the agent does it itself with
      // its own tools — clearly marked, because this part had no specialist, no
      // payment, and no receipt behind it.
      const own = await attemptItself(step, contextOverride);
      if (!own) {
        recordGrowEvent(runId, { kind: "note", summary: `No affordable "${step.capability}" specialist — skipping this step.` });
      }
      return own;
    }

    // Try the most proven first and fall down the ranking if it doesn't deliver.
    // One bad specialist used to cost the whole step; the budget is re-checked
    // each attempt because a failed hire can still have moved money.
    for (const pick of ranked.slice(0, ATTEMPTS_PER_STEP)) {
      if (isGrowRunCanceled(runId)) { stopped = true; return false; }
      const left = cfg.budgetUsdc - getGrowSpent(runId);
      if ((pick.priceUsdc ?? 0) > Math.min(cfg.perHireCapUsdc, left)) break; // can no longer afford it

      recordGrowEvent(runId, {
        kind: "hire",
        summary: `Hiring ${pick.name} (${pick.agentId})${pick.proofScore != null ? `, Proof Score ${pick.proofScore}` : ""} for "${step.capability}"${
          (pick.proofScore ?? 0) < topScore ? ` — within ${Math.round(SCORE_MARGIN * 100)}% of the best available, and cheaper` : ""
        }.`,
        toAgent: pick.agentId,
        amountUsdc: pick.priceUsdc ?? 0,
        data: { capability: step.capability, priceUsdc: pick.priceUsdc, proofScore: pick.proofScore },
      });

      try {
        const outcome = await deps.hire({
          to: pick.agentId,
          task: step.task,
          // Everything the earlier specialists produced — this is what makes an
          // ordered plan behave like one instead of a set of blind tasks.
          context: contextOverride ?? priorContext(parts),
          priceUsdc: pick.priceUsdc ?? 0,
        });
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
          // Judge what came back before it goes anywhere near the deliverable.
          // Buying work and using it unread is how a mission returns something
          // confidently wrong.
          const verdict = await reviewOutput(step.task, outcome.output);
          if (!verdict.ok && outcome.costUsdc === 0) {
            recordGrowEvent(runId, {
              kind: "review",
              summary: `Rejected ${pick.name}'s work — ${verdict.reason || "it didn't do the job"}. Trying another specialist.`,
              taskId: outcome.taskId, toAgent: pick.agentId, data: { ok: false, reason: verdict.reason },
            });
            continue;
          }
          recordGrowEvent(runId, {
            kind: "review",
            summary: verdict.ok
              ? `Checked ${pick.name}'s work — usable.`
              : `Kept ${pick.name}'s work despite doubts — ${verdict.reason || "it may be thin"} — because it was already paid for.`,
            taskId: outcome.taskId, toAgent: pick.agentId, data: { ok: verdict.ok, reason: verdict.reason, paid: outcome.costUsdc },
          });
          recordGrowEvent(runId, {
            kind: "result",
            summary: `${pick.name} delivered "${step.capability}".`,
            taskId: outcome.taskId, toAgent: pick.agentId,
            // `capability` is what the receipt and the public page label this
            // step with. Without it they fall back to this summary and print a
            // whole sentence where a keyword belongs — and on the receipt that
            // sentence is inside the hash, so it isn't only cosmetic.
            data: { capability: step.capability, receiptUrl: outcome.receiptUrl, preview: outcome.output.slice(0, 280) },
          });
          parts.push({ task: step.task, output: outcome.output });
          hires++;
          return true;
        }

        recordGrowEvent(runId, {
          kind: "error",
          summary: outcome.status === "completed"
            ? `${pick.name} completed but returned nothing usable.`
            : `${pick.name} didn't deliver (${outcome.status})${outcome.error ? `: ${outcome.error}` : ""}.`,
          taskId: outcome.taskId, toAgent: pick.agentId,
        });
        // Only fall back when the attempt cost nothing. Paying a second
        // specialist for a step already paid for would spend twice the per-hire
        // cap on one step — the cap is per hire precisely so that can't happen,
        // and doubling down on the owner's money without asking is not ours to
        // decide. A failure that took payment ends the step.
        if (outcome.costUsdc > 0) {
          recordGrowEvent(runId, {
            kind: "note",
            summary: `Already paid for "${step.capability}" — not hiring a second specialist for it.`,
          });
          break;
        }
      } catch (e) {
        // Threw before returning an outcome — the wiring bails out *before*
        // paying on every path that can, so trying the next specialist here
        // does not risk a second charge.
        recordGrowEvent(runId, { kind: "error", summary: `Hire failed: ${(e as Error).message}`, toAgent: pick.agentId });
      }
    }
    recordGrowEvent(runId, { kind: "note", summary: `No specialist delivered "${step.capability}" — moving on.` });
    return false;
  }

  /**
   * Have a go at a step nobody could be hired for. Judged by the same reviewer
   * as bought work — the agent doesn't get to grade its own homework leniently.
   */
  async function attemptItself(step: GrowSubtask, contextOverride?: string): Promise<boolean> {
    if (!deps.attempt) return false;
    let output: string;
    try {
      output = (await deps.attempt(step.task, contextOverride ?? priorContext(parts))).trim();
    } catch (e) {
      recordGrowEvent(runId, { kind: "error", summary: `Tried "${step.capability}" itself and failed: ${(e as Error).message}` });
      return false;
    }
    if (!output) return false;

    const verdict = await reviewOutput(step.task, output);
    if (!verdict.ok) {
      recordGrowEvent(runId, {
        kind: "self",
        summary: `Tried "${step.capability}" itself — not good enough to use (${verdict.reason || "didn't do the job"}).`,
        data: { ok: false, capability: step.capability, reason: verdict.reason },
      });
      return false;
    }
    recordGrowEvent(runId, {
      kind: "self",
      summary: `No specialist available for "${step.capability}" — did it itself. No hire, no payment, no receipt for this part.`,
      data: { ok: true, capability: step.capability, preview: output.slice(0, 280) },
    });
    parts.push({ task: step.task, output });
    selfDone++;
    return true;
  }

  /** Ask the specialist's own commissioner whether the work is usable. */
  async function reviewOutput(task: string, output: string): Promise<{ ok: boolean; reason: string }> {
    try {
      return parseReview(await deps.think(reviewPrompt(task, output), { maxTokens: 220 }));
    } catch {
      // The reviewer is a safeguard, not a gate. If it can't run, the work
      // stands — a broken reviewer must never silently discard paid-for results.
      return { ok: true, reason: "" };
    }
  }

  /**
   * Let the mission revise what's left of its own plan.
   *
   * A plan made before any work exists is a guess. Once results are in, some
   * remaining steps are redundant, some are impossible, and some were asking the
   * wrong question. Bounded to MAX_REPLANS so it converges rather than
   * re-deciding forever, and it can only reshape work that hasn't happened.
   */
  async function maybeReplan(): Promise<void> {
    if (queue.length === 0 || replans >= MAX_REPLANS || isGrowRunCanceled(runId)) return;
    let revised: GrowSubtask[];
    try {
      revised = parsePlan(await deps.think(replanPrompt(cfg.mission, parts, queue), { maxTokens: 1000 }));
    } catch (e) {
      recordGrowEvent(runId, { kind: "note", summary: `Kept the original plan — re-planning failed: ${(e as Error).message}` });
      return;
    }
    // An empty or unreadable revision means "no opinion", not "cancel the rest".
    if (revised.length === 0) return;
    // A revision may only reshape work that HASN'T happened. Asked to revise the
    // remainder, a model can hand back the whole plan including the finished
    // steps — and acting on that would re-commission, and re-pay for, work
    // already delivered. Anything matching a completed task is dropped.
    const doneTasks = new Set(parts.map((p) => p.task.trim().toLowerCase()));
    const fresh = revised.filter((r) => !doneTasks.has(r.task.trim().toLowerCase()));
    if (fresh.length === 0) return;
    const before = JSON.stringify(queue);
    const next = fresh.slice(0, Math.max(0, cfg.maxHires - hires));
    if (JSON.stringify(next) === before) return; // nothing changed — don't spend an event saying so
    replans++;
    queue.length = 0;
    queue.push(...next);
    updateGrowRun(runId, { plan: [...parts.map((p) => ({ capability: "done", task: p.task })), ...queue] });
    recordGrowEvent(runId, {
      kind: "plan",
      summary: `Revised the plan after seeing the results — ${queue.length} step${queue.length === 1 ? "" : "s"} left: ${queue.map((q) => q.capability).join(", ")}.`,
      data: { revision: replans, steps: queue },
    });
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
  // A stopped run still finishes what it already paid for: the specialists were
  // hired and settled, so throwing their work away would waste the owner's money.
  const finalStatus = deliverable ? "completed" : "failed";
  updateGrowRun(runId, { status: finalStatus, deliverable });
  // Say what the deliverable is actually made of. A result that is part bought
  // and part self-made is fine; one that quietly implies every part was hired
  // and witnessed is not.
  await sealManifest(deps, runId, deliverable);
  const provenance = selfDone > 0 ? `, ${selfDone} step${selfDone === 1 ? "" : "s"} done in-house (no hire, no receipt)` : "";
  recordGrowEvent(runId, {
    kind: "note",
    summary: deliverable
      ? `Mission ${stopped ? "stopped early" : "complete"} — ${hires} hire${hires === 1 ? "" : "s"}${provenance}, ${spentUsdc} USDC spent.`
      : `Mission ended without a deliverable — ${hires} hire${hires === 1 ? "" : "s"}${provenance}, ${spentUsdc} USDC spent.`,
  });

  return { run: { ...run, status: finalStatus, deliverable }, deliverable, hires, selfDone, spentUsdc };
}
