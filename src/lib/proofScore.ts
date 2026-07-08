import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { computeReputation } from "./reputation";
import { getAgentById, isContractTestAgent } from "./agents";
import { getPublicReceipt } from "./receipts";
import { getCrossNetworkSettlements } from "./crossNetwork";
import { createHash } from "crypto";

// Proof Score — a portable, third-party-verifiable reputation credential.
//
// Unlike the 0–10 network reputation (a computed number you take on trust), a
// Proof Score ships WITH its proof: the exact settled tasks that produced it,
// each linking to a public receipt, plus the raw inputs and the published
// formula. Anyone — including another agent network — can refetch the cited
// receipts, confirm the work really completed and settled on-chain, and
// recompute the score without trusting Axon.
//
// Un-gameable by construction: the proven-work component is driven only by tasks
// that ACTUALLY settled USDC on-chain (contract-test automation excluded) — an
// agent can't self-assign these, and self-dealing them only burns the protocol
// fee. Free completed work still feeds quality/reputation but never the proven-
// work booster. The whole bundle hashes to `contentHash`, so a score can be cited
// once and later checked for tampering — the portable part.

const METHOD_VERSION = "proof-score-v1";
const SCALE = 1000;
// Calibrated so proven, settled work meaningfully moves the score (it's the
// un-gameable moat) rather than quality dominating: 60/40, with anchors set for a
// young network so ~30 settled tasks / ~200 USDC reads as strong proven work and
// higher tiers are reachable as an agent builds a real settled track record.
const QUALITY_WEIGHT = 0.6; // how WELL it works: success, latency, payment reliability, reviews (+ staleness decay)
const VOLUME_WEIGHT = 0.4; // how MUCH proven, settled work stands behind it (native + cross-network)
const TASKS_ANCHOR = 30; // ~full task-volume credit near this many settled tasks (log curve, diminishing returns)
const USDC_ANCHOR = 200; // ~full settled-value credit near this much settled USDC
const MAX_EVIDENCE = 25; // most-recent settled tasks embedded inline; evidenceCount carries the true total

export interface ProofScoreEvidence {
  taskId: string; // Axon task id, or the external settlement ref for cross-network work
  network: string; // "axon" for native work, else the originating network (e.g. "agenc")
  receipt: string; // human page: /r/<taskId> for Axon, else the other network's receipt URL
  verify: string | null; // machine receipt for Axon; null for cross-network (verify via `receipt` on that network)
  completedAt: string;
  settledUsdc: number;
}

export interface ProofScore {
  agentId: string;
  name: string;
  score: number; // 0..SCALE
  tier: string;
  // Raw inputs — all derivable from public receipts, so the score is recomputable.
  inputs: {
    reputation: number; // 0..10, the quality basis (already staleness-decayed)
    tasksCompleted: number;
    tasksFailed: number;
    successRate: number; // 0..1
    paymentReliability: number; // 0..1
    avgResponseSec: number;
    settledUsdc: number;
    staleDays: number | null;
    decayFactor: number; // 0..1
  };
  components: {
    quality: { factor: number; weight: number; points: number };
    provenWork: { factor: number; weight: number; points: number };
  };
  // The settled tasks that back the score — each independently checkable.
  evidence: ProofScoreEvidence[];
  evidenceCount: number; // total settled tasks backing the score (evidence[] capped at MAX_EVIDENCE)
  method: {
    version: string;
    scale: number;
    weights: { quality: number; provenWork: number };
    anchors: { tasks: number; usdc: number };
    formula: string;
    howToVerify: string;
  };
  contentHash: string; // sha256 of the canonical proof (excludes this field + generatedAt) — tamper-evident, citable
  generatedAt: string;
}

const round = (n: number, dp = 3): number => { const f = 10 ** dp; return Math.round(n * f) / f; };

// Log curve with diminishing returns: 0 at 0, ~1 near the anchor, hard-capped at 1.
const curve = (value: number, anchor: number): number =>
  Math.min(1, Math.log10(1 + Math.max(0, value)) / Math.log10(1 + anchor));

function provenWorkFactor(completed: number, settledUsdc: number): number {
  return Math.min(1, 0.6 * curve(completed, TASKS_ANCHOR) + 0.4 * curve(settledUsdc, USDC_ANCHOR));
}

function tierFor(score: number): string {
  if (score >= 900) return "Elite";
  if (score >= 750) return "Trusted";
  if (score >= 500) return "Established";
  if (score >= 250) return "Emerging";
  return "New";
}

// Deterministic, sorted-key JSON so contentHash is stable across runs and machines.
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}
const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

interface WorkItem {
  taskId: string; // Axon task id, or the external ref for cross-network work
  network: string; // "axon" or the originating network (e.g. "agenc")
  receipt: string;
  verify: string | null;
  completedAt: string;
  settledUsdc: number;
}

// All settled work backing the score — native Axon settlements PLUS settlements
// the agent earned on other networks (portability). This is the un-gameable core:
// only work that ACTUALLY settled USDC counts. Free completed tasks are excluded
// (they still feed quality/reputation) so an attacker can't inflate volume with
// self-dealt free tasks — a settled task costs the buyer real USDC, and
// self-dealing only burns the protocol fee. Cross-network items carry the other
// network's receipt so they stay independently verifiable.
function settledWork(agentId: string): WorkItem[] {
  const rows = getDb()
    .prepare(
      `SELECT t.task_id, t.completed_at, t.from_agent,
              (SELECT x.amount_sol FROM transactions x
                 WHERE x.task_id = t.task_id AND x.to_agent = t.to_agent
                   AND x.status = 'completed' AND x.currency = 'USDC' LIMIT 1) AS settled_usdc
         FROM tasks t
        WHERE t.to_agent = ? AND t.status = 'completed' AND t.completed_at IS NOT NULL`,
    )
    .all(agentId) as { task_id: string; completed_at: string; from_agent: string; settled_usdc: number | null }[];

  const native: WorkItem[] = rows
    .filter((r) => !isContractTestAgent(r.from_agent) && (r.settled_usdc ?? 0) > 0)
    .map((r) => ({
      taskId: r.task_id,
      network: "axon",
      receipt: `/r/${r.task_id}`,
      verify: `/api/receipts/${r.task_id}/public`,
      completedAt: r.completed_at,
      settledUsdc: r.settled_usdc as number,
    }));

  const cross: WorkItem[] = getCrossNetworkSettlements(agentId).map((s) => ({
    taskId: s.externalRef,
    network: s.network,
    receipt: s.receiptUrl,
    verify: null,
    completedAt: s.settledAt,
    settledUsdc: s.usdc,
  }));

  // Deterministic total order (newest first, then id) across both sources, so the
  // evidence array — and thus contentHash — is byte-identical on every recompute.
  return [...native, ...cross].sort((a, b) =>
    a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : a.taskId.localeCompare(b.taskId),
  );
}

// Full, uncapped evidence for INDEPENDENT verification — every settled task, so a
// client can re-fetch each receipt and recompute the score itself. computeProofScore
// only inlines the most-recent MAX_EVIDENCE (to keep the proof small and its hash
// stable), but the score is computed over ALL of them — so a trustless recompute
// needs the complete list, not the capped one.
export function getProofScoreEvidence(agentId: string): ProofScoreEvidence[] | null {
  if (!getAgentById(agentId)) return null;
  return settledWork(agentId).map((w) => ({
    taskId: w.taskId,
    network: w.network,
    receipt: w.receipt,
    verify: w.verify,
    completedAt: w.completedAt,
    settledUsdc: round(w.settledUsdc, 6),
  }));
}

export function computeProofScore(agentId: string): ProofScore | null {
  const agent = getAgentById(agentId);
  if (!agent) return null;

  const rep = computeReputation(agentId); // canonical network quality signal (staleness-decayed)
  const work = settledWork(agentId);
  const settledUsdc = round(work.reduce((s, w) => s + w.settledUsdc, 0), 6);
  const settledCount = work.length;

  const qualityFactor = round(rep.reputation / 10); // 0..1
  const volumeFactor = round(provenWorkFactor(settledCount, settledUsdc)); // 0..1
  const qualityPoints = round(SCALE * QUALITY_WEIGHT * qualityFactor, 2);
  const volumePoints = round(SCALE * VOLUME_WEIGHT * volumeFactor, 2);
  const score = Math.round(qualityPoints + volumePoints);

  const evidence: ProofScoreEvidence[] = work.slice(0, MAX_EVIDENCE).map((w) => ({
    taskId: w.taskId,
    network: w.network,
    receipt: w.receipt,
    verify: w.verify,
    completedAt: w.completedAt,
    settledUsdc: round(w.settledUsdc, 6),
  }));

  // `body` is everything the contentHash commits to — deterministic for the same
  // underlying data, so the same agent state always yields the same hash
  // (generatedAt is deliberately excluded so it stays stable and citable).
  const body = {
    agentId: agent.agentId,
    name: agent.name,
    score,
    tier: tierFor(score),
    inputs: {
      reputation: rep.reputation,
      tasksCompleted: rep.totalTasksCompleted,
      tasksFailed: rep.totalTasksFailed,
      successRate: round(rep.successRate),
      paymentReliability: round(rep.paymentReliability),
      avgResponseSec: rep.avgResponseTimeSec,
      settledUsdc,
      staleDays: rep.staleDays,
      decayFactor: rep.decayFactor,
    },
    components: {
      quality: { factor: qualityFactor, weight: QUALITY_WEIGHT, points: qualityPoints },
      provenWork: { factor: volumeFactor, weight: VOLUME_WEIGHT, points: volumePoints },
    },
    evidence,
    evidenceCount: settledCount,
    method: {
      version: METHOD_VERSION,
      scale: SCALE,
      weights: { quality: QUALITY_WEIGHT, provenWork: VOLUME_WEIGHT },
      anchors: { tasks: TASKS_ANCHOR, usdc: USDC_ANCHOR },
      formula:
        "score = round(scale * (quality.weight*quality.factor + provenWork.weight*provenWork.factor)); " +
        "quality.factor = reputation/10 (staleness-decayed blend of success, latency, payment reliability, reviews); " +
        "provenWork.factor = min(1, 0.6*log10(1+evidenceCount)/log10(1+tasksAnchor) + 0.4*log10(1+settledUsdc)/log10(1+usdcAnchor)), " +
        "where evidenceCount = the number of SETTLED tasks backing the score (native + cross-network, NOT inputs.tasksCompleted) and settledUsdc = their summed USDC.",
      howToVerify:
        "Refetch each evidence[].verify receipt to confirm the task completed and settled on-chain. Cross-network items " +
        "(network != 'axon') have verify=null — confirm those via evidence[].receipt on the originating network. Evidence lists the " +
        `most-recent ${MAX_EVIDENCE}; evidenceCount is the true total. Recompute inputs, apply the formula, and check it equals score. ` +
        "Recompute contentHash over the canonical (sorted-key) proof — all fields except contentHash and generatedAt — to confirm it is untampered.",
    },
  };

  return { ...body, contentHash: sha256hex(canonical(body)), generatedAt: new Date().toISOString() };
}

// Cache the Proof Score + tier on the agent row (mirrors updateAgentReputation) so
// list views (marketplace directory, search API) read a column instead of computing
// the full proof per agent. Called on task completion and by the daily cron.
export function updateAgentProofScore(agentId: string): number | null {
  const p = computeProofScore(agentId);
  if (!p) return null;
  getDb().prepare("UPDATE agents SET proof_score = ?, proof_score_tier = ? WHERE agent_id = ?").run(p.score, p.tier, agentId);
  void syncToTurso();
  return p.score;
}

// Recompute + persist the cached Proof Score for every agent. Run by the daily
// cron alongside recomputeAllReputations so staleness decay + new settlements
// materialize in the cached columns list views badge by. Returns the count.
export function recomputeAllProofScores(): number {
  const db = getDb();
  const ids = db.prepare("SELECT agent_id FROM agents").all() as { agent_id: string }[];
  const update = db.prepare("UPDATE agents SET proof_score = ?, proof_score_tier = ? WHERE agent_id = ?");
  const apply = db.transaction((rows: { agent_id: string }[]) => {
    for (const { agent_id } of rows) {
      const p = computeProofScore(agent_id);
      if (p) update.run(p.score, p.tier, agent_id);
    }
  });
  apply(ids);
  void syncToTurso();
  return ids.length;
}

export interface ProofScoreVerification {
  agentId: string;
  score: number;
  contentHash: string;
  verified: boolean; // every native settlement re-confirmed on-chain AND the score recomputes
  receiptsChecked: number; // native Axon settlements re-fetched from public receipts
  receiptsSettled: number; // of those, confirmed completed with an on-chain settlement
  crossNetworkSettlements: number; // cross-network settlements counted (verify externally via each evidence receipt)
  confirmedUsdc: number; // USDC summed only from confirmed settlements (native + cross-network)
  recomputedScore: number; // score re-derived from what was confirmed
  scoreMatches: boolean;
  checkedAt: string;
  note: string;
}

// Independent verification: re-walk every settlement the score cites. For native
// Axon work, refetch the PUBLIC receipt and confirm it completed + settled on-chain.
// Cross-network settlements are counted and carry the other network's receipt URL
// (verify externally). Then recompute the proven-work factor and score from what
// was confirmed. This is what a third party does — it trusts the receipts, not the score.
export function verifyProofScore(agentId: string): ProofScoreVerification | null {
  const proof = computeProofScore(agentId);
  if (!proof) return null;

  const work = settledWork(agentId);
  const nativeCount = work.filter((w) => w.network === "axon").length;
  let receiptsSettled = 0;
  let crossNetwork = 0;
  let confirmedUsdc = 0;
  for (const w of work) {
    if (w.network === "axon") {
      const r = getPublicReceipt(w.taskId);
      if (r && r.status === "completed" && r.settlement) {
        receiptsSettled++;
        confirmedUsdc += w.settledUsdc;
      }
    } else {
      crossNetwork++; // externally verifiable via w.receipt on the originating network
      confirmedUsdc += w.settledUsdc;
    }
  }
  confirmedUsdc = round(confirmedUsdc, 6);

  const recomputedVolume = round(provenWorkFactor(receiptsSettled + crossNetwork, confirmedUsdc));
  const recomputedScore = Math.round(
    round(SCALE * QUALITY_WEIGHT * proof.components.quality.factor, 2) + round(SCALE * VOLUME_WEIGHT * recomputedVolume, 2),
  );
  const scoreMatches = recomputedScore === proof.score;
  const nativeAllSettled = receiptsSettled === nativeCount;

  const crossNote = crossNetwork > 0 ? ` (+${crossNetwork} cross-network, verify via each receipt)` : "";
  return {
    agentId: proof.agentId,
    score: proof.score,
    contentHash: proof.contentHash,
    verified: nativeAllSettled && scoreMatches,
    receiptsChecked: nativeCount,
    receiptsSettled,
    crossNetworkSettlements: crossNetwork,
    confirmedUsdc,
    recomputedScore,
    scoreMatches,
    checkedAt: new Date().toISOString(),
    note: nativeAllSettled && scoreMatches
      ? `Re-fetched all ${nativeCount} native settlement${nativeCount !== 1 ? "s" : ""} from public receipts and confirmed each on-chain${crossNote}; score recomputed and matches.`
      : `${receiptsSettled}/${nativeCount} native receipts confirmed${crossNote}; recomputed score ${scoreMatches ? "matches" : `differs (${recomputedScore} vs ${proof.score})`}.`,
  };
}
