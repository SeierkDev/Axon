// The mission receipt.
//
// Every hire a mission makes is already provable on its own — it's an ordinary
// Axon task with a public receipt at /r/<taskId>. The DELIVERABLE wasn't. You
// could hand someone the finished result and they had to take your word for how
// it was made, which is the one thing Axon exists not to ask of people.
//
// A manifest fixes that: every step in order, who did it, what it cost, the hash
// of what they returned, each entry chained to the one before. Anyone holding the
// manifest and the deliverable can check three things without trusting us —
// the chain is intact, the deliverable hashes to what the manifest claims, and
// each hire's receipt independently confirms the work and the payment.
//
// It carries HASHES of content, never content. The mission brief and the
// deliverable stay the owner's to share; the manifest only pins them.

import { canonicalStringify, sha256hex, hashContent } from "./traceEvents";
import type { GrowEvent, GrowRun } from "./grow";

export interface MissionManifestEntry {
  /** Position in the mission, 1-based. */
  seq: number;
  /** "hire" — bought from a specialist — or "in-house", done by the agent itself. */
  source: "hire" | "in-house";
  capability: string;
  /** The specialist, when there was one. */
  agentId?: string;
  /** The task, when there was one — this is what makes the step independently checkable. */
  taskId?: string;
  receiptUrl?: string;
  costUsdc: number;
  /** sha256 of what the step returned. */
  outputHash: string | null;
  /** sha256 over this entry's fields plus the previous entry's hash. */
  prevHash: string | null;
  hash: string;
}

export interface MissionManifest {
  version: 1;
  runId: string;
  agentId: string;
  /** The brief, hashed. The text itself stays private unless the owner shares it. */
  missionHash: string | null;
  budgetUsdc: number;
  startedAt: string;
  completedAt: string | null;
  status: GrowRun["status"];
  entries: MissionManifestEntry[];
  totals: {
    hires: number;
    /** Steps with no specialist behind them — no payment, no receipt. */
    inHouse: number;
    spentUsdc: number;
  };
  /** sha256 of the deliverable, so the result can be pinned without publishing it. */
  deliverableHash: string | null;
  /** sha256 over everything above. Changing any field changes this. */
  hash: string;
}

/** Money actually paid for a given task, from the timeline's payment events. */
function paidFor(events: GrowEvent[], taskId: string | undefined): number {
  if (!taskId) return 0;
  return events
    .filter((e) => e.kind === "payment" && e.taskId === taskId)
    .reduce((sum, e) => sum + (e.amountUsdc ?? 0), 0);
}

/**
 * Build the manifest for a finished mission.
 *
 * Reads only what the timeline already recorded, so it describes what actually
 * happened rather than what was planned. `outputs` supplies the full text per
 * task when it's available — the timeline keeps a 280-character preview, and
 * hashing the preview would pin something nobody can reproduce, so a step whose
 * full output can't be recovered gets a null hash and says so by omission rather
 * than claiming a hash that verifies against nothing.
 */
export function buildMissionManifest(
  run: GrowRun,
  events: GrowEvent[],
  opts: { deliverable?: string; outputs?: Map<string, string> } = {},
): MissionManifest {
  const entries: MissionManifestEntry[] = [];
  let prevHash: string | null = null;
  let seq = 0;

  // "result" = a specialist delivered; "self" (ok) = the agent did it itself.
  // Both are steps that reached the deliverable, and the difference between them
  // is exactly what a reader needs to see.
  const steps = events.filter(
    (e) => e.kind === "result" || (e.kind === "self" && (e.data as { ok?: boolean } | undefined)?.ok === true),
  );

  for (const ev of steps) {
    seq += 1;
    const isHire = ev.kind === "result";
    const full = ev.taskId ? opts.outputs?.get(ev.taskId) : undefined;
    const fields = {
      seq,
      source: isHire ? ("hire" as const) : ("in-house" as const),
      capability: (ev.data as { capability?: string } | undefined)?.capability ?? ev.summary,
      agentId: isHire ? ev.toAgent ?? undefined : undefined,
      taskId: isHire ? ev.taskId ?? undefined : undefined,
      costUsdc: isHire ? paidFor(events, ev.taskId) : 0,
      outputHash: full ? hashContent(full) : null,
      prevHash,
    };
    const hash = sha256hex(canonicalStringify(fields));
    entries.push({
      ...fields,
      receiptUrl: fields.taskId ? `/r/${fields.taskId}` : undefined,
      hash,
    });
    prevHash = hash;
  }

  const totals = {
    hires: entries.filter((e) => e.source === "hire").length,
    inHouse: entries.filter((e) => e.source === "in-house").length,
    spentUsdc: Math.round(entries.reduce((s, e) => s + e.costUsdc, 0) * 10000) / 10000,
  };

  const body = {
    version: 1 as const,
    runId: run.runId,
    agentId: run.agentId,
    missionHash: hashContent(run.mission),
    budgetUsdc: run.budgetUsdc,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
    status: run.status,
    entries,
    totals,
    deliverableHash: hashContent(opts.deliverable ?? run.deliverable),
  };
  return { ...body, hash: sha256hex(canonicalStringify(body)) };
}

export interface MissionVerification {
  ok: boolean
  /** Every entry's hash recomputes, and each links to the one before. */
  chainIntact: boolean;
  /** The manifest's own hash matches its contents. */
  manifestHashMatches: boolean;
  /** Only when a deliverable was supplied to check against. */
  deliverableMatches: boolean | null;
  /** Steps with no specialist behind them — worth stating plainly to a reader. */
  inHouseSteps: number;
  problems: string[];
}

/**
 * Check a manifest without trusting whoever handed it to you.
 *
 * Recomputes every entry hash and the manifest hash from the fields present, so
 * a tampered cost, a swapped specialist, or a re-ordered step all fail. Pass the
 * deliverable to confirm the result is the one this manifest describes.
 */
export function verifyMissionManifest(
  manifest: MissionManifest,
  opts: { deliverable?: string } = {},
): MissionVerification {
  const problems: string[] = [];
  let prevHash: string | null = null;
  let chainIntact = true;

  manifest.entries.forEach((e, i) => {
    const recomputed = sha256hex(
      canonicalStringify({
        seq: e.seq,
        source: e.source,
        capability: e.capability,
        agentId: e.agentId,
        taskId: e.taskId,
        costUsdc: e.costUsdc,
        outputHash: e.outputHash,
        prevHash: e.prevHash,
      }),
    );
    if (recomputed !== e.hash) {
      chainIntact = false;
      problems.push(`entry ${i + 1} (${e.capability}) has been altered`);
    }
    if (e.prevHash !== prevHash) {
      chainIntact = false;
      problems.push(`entry ${i + 1} does not follow the one before it`);
    }
    prevHash = e.hash;
  });

  const { hash, ...body } = manifest;
  const manifestHashMatches = sha256hex(canonicalStringify(body)) === hash;
  if (!manifestHashMatches) problems.push("the manifest itself has been altered");

  let deliverableMatches: boolean | null = null;
  if (opts.deliverable !== undefined) {
    deliverableMatches = hashContent(opts.deliverable) === manifest.deliverableHash;
    if (!deliverableMatches) problems.push("this is not the deliverable the manifest describes");
  }

  return {
    ok: chainIntact && manifestHashMatches && deliverableMatches !== false,
    chainIntact,
    manifestHashMatches,
    deliverableMatches,
    inHouseSteps: manifest.totals.inHouse,
    problems,
  };
}
