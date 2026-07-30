// What a published mission shows the world.
//
// One place, on purpose. Publishing is the only thing in Missions that makes
// CONTENT public — the brief and the result, in full, because that's the point
// of showing someone what your agent made. Everything else about a run stays
// private, and the difference between those two sets is worth being able to read
// in a single file rather than reconstructing it from three route handlers.
//
// Never included, and never should be: the owner's wallet, the plan the agent
// was working from, or the raw `data` blobs on timeline events. The steps come
// from the mission's own manifest, which is already the curated, chained record
// of what happened — so the public page and the receipt can't drift apart.

import { verifyMissionManifest, type MissionManifest, type MissionVerification } from "./growReceipt";
import { getMissionTemplate } from "./missionTemplates";
import type { GrowEvent, GrowRun } from "./grow";

export interface PublicMissionStep {
  seq: number;
  /** "hire" — bought from a specialist — or "in-house", done by the agent itself. */
  source: "hire" | "in-house";
  capability: string;
  /** The specialist, when there was one. Agent ids are already public. */
  agentId?: string;
  taskId?: string;
  /** Where anyone can verify this step independently. */
  receiptUrl?: string;
  costUsdc: number;
}

export interface PublicMission {
  runId: string;
  /** The agent that ran it. Public — agents are listed publicly. */
  agentId: string;
  /** The brief, published deliberately by the owner. */
  mission: string;
  /** The result, published deliberately by the owner. */
  deliverable?: string;
  status: GrowRun["status"];
  budgetUsdc: number;
  publishedAt?: string;
  completedAt?: string;
  /** Where to start the same job yourself. */
  template: { id: string; title: string } | null;
  steps: PublicMissionStep[];
  totals: { hires: number; inHouse: number; spentUsdc: number };
  /** The receipt's chain hash and its verification, so the page is checkable. */
  receipt: { hash: string; verification: MissionVerification } | null;
}

/**
 * The steps and totals of a run, from its manifest when it has one and from the
 * timeline when it doesn't.
 *
 * Shared on purpose. The card and the page used to work this out separately, and
 * a run whose receipt failed to seal showed "1 hire" on the page and "0 hires" on
 * its own gallery card — sealing is best-effort, so that isn't hypothetical.
 */
function deriveSteps(run: GrowRun, events: GrowEvent[]): { steps: PublicMissionStep[]; totals: PublicMission["totals"] } {
  const manifest = (run.manifest ?? null) as MissionManifest | null;

  if (manifest?.entries) {
    return {
      steps: manifest.entries.map((e) => ({
        seq: e.seq,
        source: e.source,
        capability: e.capability,
        agentId: e.agentId,
        taskId: e.taskId,
        receiptUrl: e.receiptUrl,
        costUsdc: e.costUsdc,
      })),
      totals: manifest.totals,
    };
  }

  // No manifest — rebuild the same shape from the timeline. Deliberately narrow:
  // summaries and costs only, never the `data` blobs, which carry previews and
  // internals that publication was never asked to include.
  const paid = (taskId?: string) =>
    taskId
      ? events
          .filter((e) => e.kind === "payment" && e.taskId === taskId)
          .reduce((s, e) => s + (e.amountUsdc ?? 0), 0)
      : 0;
  let seq = 0;
  const steps: PublicMissionStep[] = events
    .filter((e) => e.kind === "result" || (e.kind === "self" && (e.data as { ok?: boolean } | undefined)?.ok === true))
    .map((e) => {
      seq += 1;
      const isHire = e.kind === "result";
      return {
        seq,
        source: isHire ? ("hire" as const) : ("in-house" as const),
        capability: (e.data as { capability?: string } | undefined)?.capability ?? e.summary,
        agentId: isHire ? e.toAgent : undefined,
        taskId: isHire ? e.taskId : undefined,
        receiptUrl: isHire && e.taskId ? `/r/${e.taskId}` : undefined,
        costUsdc: isHire ? paid(e.taskId) : 0,
      };
    });
  return {
    steps,
    totals: {
      hires: steps.filter((s) => s.source === "hire").length,
      inHouse: steps.filter((s) => s.source === "in-house").length,
      spentUsdc: Math.round(steps.reduce((s, x) => s + x.costUsdc, 0) * 10000) / 10000,
    },
  };
}

/**
 * The public view of a mission: only what publication is meant to expose.
 *
 * `events` is not optional — a caller that omits the timeline gets the degraded
 * path silently, which is exactly how the gallery card came to report zero hires
 * for a run that had made several.
 */
export function toPublicMission(run: GrowRun, events: GrowEvent[]): PublicMission {
  const manifest = (run.manifest ?? null) as MissionManifest | null;
  const tpl = getMissionTemplate(run.templateId);
  const { steps, totals } = deriveSteps(run, events);

  return {
    runId: run.runId,
    agentId: run.agentId,
    mission: run.mission,
    deliverable: run.deliverable,
    status: run.status,
    budgetUsdc: run.budgetUsdc,
    publishedAt: run.publishedAt,
    completedAt: run.completedAt,
    template: tpl ? { id: tpl.id, title: tpl.title } : null,
    steps,
    totals,
    receipt: manifest ? { hash: manifest.hash, verification: verifyMissionManifest(manifest) } : null,
  };
}

/** The trimmed shape the gallery lists — no deliverable, no steps. */
export interface PublicMissionCard {
  runId: string;
  agentId: string;
  mission: string;
  publishedAt?: string;
  template: { id: string; title: string } | null;
  hires: number;
  spentUsdc: number;
}

export function toPublicMissionCard(run: GrowRun, events: GrowEvent[]): PublicMissionCard {
  const tpl = getMissionTemplate(run.templateId);
  const { totals } = deriveSteps(run, events);
  return {
    runId: run.runId,
    agentId: run.agentId,
    mission: run.mission,
    publishedAt: run.publishedAt,
    template: tpl ? { id: tpl.id, title: tpl.title } : null,
    hires: totals.hires,
    spentUsdc: totals.spentUsdc,
  };
}
