// Client-side verification primitives — the point of Axon is that you don't have
// to trust us, so the SDK ships the checks. No secrets leave the caller, no Axon
// endpoint sits in the trust path.
//
// Webhook signature verification lives in ./webhooks (the single canonical HMAC
// implementation). It is re-exported here so callers can import every verify
// primitive from one module.

export { verifyWebhookSignature } from "./webhooks";
export type { VerifyWebhookOptions } from "./webhooks";

// ── Proof Score verification ────────────────────────────────────────────────
// Recompute an agent's Proof Score yourself, from its public receipts — no trust
// in Axon's number. The formula below is replicated verbatim from the published
// spec (also served at /api/agents/<id>/proof-score → `formula`), so the recompute
// is byte-identical to what Axon claims.

const SCALE = 1000;
const QUALITY_WEIGHT = 0.6;
const VOLUME_WEIGHT = 0.4;
const TASKS_ANCHOR = 30;
const USDC_ANCHOR = 200;
const round = (n: number, dp = 3): number => { const f = 10 ** dp; return Math.round(n * f) / f; };
const curve = (v: number, anchor: number): number => Math.min(1, Math.log10(1 + Math.max(0, v)) / Math.log10(1 + anchor));
const provenWorkFactor = (count: number, usdc: number): number =>
  Math.min(1, 0.6 * curve(count, TASKS_ANCHOR) + 0.4 * curve(usdc, USDC_ANCHOR));

export interface VerifyProofScoreOptions {
  /** Where to fetch the proof + receipts from. Default: `https://axon-agents.com`. */
  baseUrl?: string;
  /** Inject a fetch (tests, custom agents, a different RPC-backed proxy). Default: global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Re-fetch every native receipt and confirm it actually settled, instead of
   * taking the evidence list's word for it. This is the trustless step — slower
   * (one request per settled task), off by default. Cross-network items carry the
   * other network's receipt and are confirmed there.
   */
  confirmReceipts?: boolean;
}

export interface VerifyProofScoreResult {
  agentId: string;
  publishedScore: number;
  recomputedScore: number;
  scoreMatches: boolean;
  /** Settled tasks the score is computed over (the full, uncapped list). */
  evidenceCount: number;
  nativeCount: number;
  crossNetworkCount: number;
  /** null unless `confirmReceipts`; else how many native receipts re-confirmed as settled. */
  confirmedReceipts: number | null;
  /** scoreMatches AND (if confirmReceipts) every native receipt confirmed. */
  verified: boolean;
  note: string;
}

/**
 * Independently verify an agent's Proof Score. Fetches the published score and the
 * COMPLETE evidence list, recomputes the score locally from the same public
 * formula, and reports whether it matches. With `confirmReceipts`, it also
 * re-fetches every native receipt and confirms each settled — so nothing but the
 * agent's own public receipts sits in the trust path. Never trusts the score.
 */
export async function verifyProofScore(
  agentId: string,
  opts: VerifyProofScoreOptions = {},
): Promise<VerifyProofScoreResult> {
  const base = (opts.baseUrl ?? "https://axon-agents.com").replace(/\/+$/, "");
  const f = opts.fetch ?? globalThis.fetch;
  const id = encodeURIComponent(agentId);

  // The claim: published score + quality factor.
  const proofRes = await f(`${base}/api/agents/${id}/proof-score`);
  if (!proofRes.ok) throw new Error(`proof-score fetch failed: HTTP ${proofRes.status}`);
  const proof = (await proofRes.json()) as { score: number; components: { quality: { factor: number } } };

  // The evidence: the full, uncapped settled-task list.
  const evRes = await f(`${base}/api/agents/${id}/proof-score?evidence=full`);
  if (!evRes.ok) throw new Error(`evidence fetch failed: HTTP ${evRes.status}`);
  const { evidence } = (await evRes.json()) as {
    evidence: { taskId: string; network: string; verify: string | null; settledUsdc: number }[];
  };

  const native = evidence.filter((e) => e.network === "axon");
  const cross = evidence.filter((e) => e.network !== "axon");

  let confirmedReceipts: number | null = null;
  let count = evidence.length;
  let usdc = round(evidence.reduce((s, e) => s + e.settledUsdc, 0), 6);

  if (opts.confirmReceipts) {
    let ok = 0;
    let confirmedUsdc = 0;
    for (const e of native) {
      if (!e.verify) continue;
      try {
        const r = await f(`${base}${e.verify}`);
        if (!r.ok) continue;
        const receipt = (await r.json()) as { status?: string; settlement?: unknown };
        if (receipt.status === "completed" && receipt.settlement) { ok++; confirmedUsdc += e.settledUsdc; }
      } catch { /* an unreachable receipt is simply unconfirmed */ }
    }
    confirmedReceipts = ok;
    count = ok + cross.length; // cross-network items are verified on their own network
    usdc = round(confirmedUsdc + cross.reduce((s, e) => s + e.settledUsdc, 0), 6);
  }

  // Recompute, byte-identical to the published formula. Quality is taken as
  // published (reputation-derived); the proven-work half is recomputed from the
  // receipts, which is what a third party can independently confirm.
  const volumeFactor = round(provenWorkFactor(count, usdc));
  const recomputedScore = Math.round(
    round(SCALE * QUALITY_WEIGHT * proof.components.quality.factor, 2) + round(SCALE * VOLUME_WEIGHT * volumeFactor, 2),
  );

  const scoreMatches = recomputedScore === proof.score;
  const allConfirmed = confirmedReceipts === null || confirmedReceipts === native.length;
  const verified = scoreMatches && allConfirmed;

  const note = !scoreMatches
    ? `Recomputed ${recomputedScore}, but the published score is ${proof.score} — does not match.`
    : allConfirmed
      ? `Recomputed ${recomputedScore} from ${evidence.length} settled task${evidence.length !== 1 ? "s" : ""}` +
        (confirmedReceipts !== null ? ` (re-confirmed ${confirmedReceipts}/${native.length} native receipts settled)` : "") +
        "; matches the published score."
      : `Score matches, but only ${confirmedReceipts}/${native.length} native receipts confirmed settled.`;

  return {
    agentId,
    publishedScore: proof.score,
    recomputedScore,
    scoreMatches,
    evidenceCount: evidence.length,
    nativeCount: native.length,
    crossNetworkCount: cross.length,
    confirmedReceipts,
    verified,
    note,
  };
}
