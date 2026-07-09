// Reproducibility proofs — Proof Layer #2.
//
// A receipt proves a task ran and settled. Reproducibility proves it ran *right*:
// re-run the task deterministically and check the new output against the original.
//
//   - We freeze the recorded input (spec + context), pin the originally-used
//     model, and run at temperature 0 — the most deterministic re-run available.
//   - "exact"      — the re-run output hashes to the same value as the receipt.
//   - "equivalent" — hashes differ (models are not bit-deterministic) but the two
//     outputs are lexically the same work: cosine similarity over token
//     frequencies >= threshold. The formula is published so anyone holding both
//     outputs recomputes the same number with NO model or API key.
//   - "divergent"  — the re-run produced materially different work.
//
// Privacy face matches receipts + traces (migration 039): the public proof carries
// only hashes, the verdict, the similarity, and the published method — never the
// output text. The reproduced output is stored privately (owner-recomputable).

import { createHash } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { hashOutput } from "./outputCommitment";
import { getTaskById } from "./tasks";
import { getAgentById } from "./agents";
import { formatContext } from "./formatContext";
import { getPublicTrace } from "./traceEvents";
import { getAgentMaxTokens, runReproduction, effectiveModel } from "./providers";
import type { Agent } from "@/sdk/types";

// Agents whose task input includes live runtime data (market prices appended at
// run time) — mirrors PRICE_AGENTS in src/workers/index.ts. A deterministic re-run
// can't feed them the same prompt the original saw, so we refuse to emit a proof
// rather than publish a misleading (usually false-divergent) verdict.
const NON_REPRODUCIBLE_AGENTS = new Set(["crypto-agent", "trading-agent"]);

// Client-side reproduce failures (missing/incomplete/non-reproducible task) carry
// an HTTP status so the route reports 404/422 instead of a 502 — typed, so status
// never depends on matching free-text error messages.
export class ReproError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 422,
  ) {
    super(message);
    this.name = "ReproError";
  }
}

// Outputs at or above this lexical similarity are judged the same work when their
// hashes differ. Published in every proof's `method` so it's not a hidden knob.
//
// Empirically calibrated (2026-07-09) against live runs: honest same-task re-runs
// of current models (which deprecate temperature, so sampling varies freely)
// scored 0.62–0.86 across task styles (n=5), while answers to DIFFERENT tasks
// scored ≤0.48 at the 99th percentile over 528 pairs. 0.55 sits in the gap:
// honest reproduction passes, materially different output does not.
export const EQUIVALENCE_THRESHOLD = 0.55;

export type ReproVerdict = "exact" | "equivalent" | "divergent";

export interface ReproMethod {
  formula: string;
  threshold: number;
  inputHash: string; // sha256 of the reconstructed input that was re-run
  note: string;
}

export interface ReproProof {
  taskId: string;
  verdict: ReproVerdict;
  similarity: number; // 0..1, rounded to 6dp for stable hashing
  originalOutputHash: string;
  reproducedOutputHash: string;
  model: string | null; // model used for the deterministic re-run
  // 0 when the provider accepts a temperature; null for providers whose current
  // models deprecate the parameter (Anthropic) — never claim a knob we didn't set.
  temperature: number | null;
  method: ReproMethod;
  contentHash: string; // sha256 of the canonical proof body (excludes reproducedAt)
  reproducedAt: string;
}

// ── Deterministic, published similarity ──────────────────────────────────────
// Cosine similarity over lowercased [a-z0-9]+ token-frequency vectors. Chosen
// over embeddings precisely because it needs no model to recompute — a third
// party with both outputs gets the identical number, keeping the proof
// trust-minimized.

export function tokenFrequency(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g);
  if (tokens) for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

export function lexicalSimilarity(a: string, b: string): number {
  const va = tokenFrequency(a);
  const vb = tokenFrequency(b);
  if (va.size === 0 && vb.size === 0) return 1;
  if (va.size === 0 || vb.size === 0) return 0;
  let dot = 0;
  for (const [t, c] of va) {
    const d = vb.get(t);
    if (d) dot += c * d;
  }
  let na = 0;
  for (const c of va.values()) na += c * c;
  let nb = 0;
  for (const c of vb.values()) nb += c * c;
  // Clamp: floating-point rounding can nudge an identical-vector cosine just past 1.
  return Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

export function reproVerdict(originalHash: string, reproHash: string, similarity: number): ReproVerdict {
  if (reproHash === originalHash) return "exact";
  return similarity >= EQUIVALENCE_THRESHOLD ? "equivalent" : "divergent";
}

export interface ReproComparison {
  originalOutputHash: string;
  reproducedOutputHash: string;
  similarity: number;
  verdict: ReproVerdict;
}

// Pure comparison of two outputs — the whole verdict logic, testable with no DB
// or model. Similarity is rounded to 6dp so the content hash is stable.
export function compareOutputs(original: string, reproduced: string): ReproComparison {
  const originalOutputHash = hashOutput(original);
  const reproducedOutputHash = hashOutput(reproduced);
  const similarity = Math.round(lexicalSimilarity(original, reproduced) * 1e6) / 1e6;
  return {
    originalOutputHash,
    reproducedOutputHash,
    similarity,
    verdict: reproVerdict(originalOutputHash, reproducedOutputHash, similarity),
  };
}

// ── Canonical content hash (tamper-evident, recomputable) ────────────────────

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

interface ReproHashBody {
  taskId: string;
  verdict: ReproVerdict;
  similarity: number;
  originalOutputHash: string;
  reproducedOutputHash: string;
  model: string | null;
  temperature: number | null;
  method: ReproMethod;
}

export function hashReproProof(body: ReproHashBody): string {
  return createHash("sha256").update(canonicalize(body), "utf8").digest("hex");
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface ReproRunContext {
  agent: Agent;
  message: string;
  maxTokens: number;
  model: string | null;
  temperature: number | null;
}

export interface ReproduceOptions {
  // Injectable re-runner — production runs the real provider; tests pass a stub so
  // no model is called. Returns the reproduced output text.
  runner?: (ctx: ReproRunContext) => Promise<string>;
  persist?: boolean; // default true
}

// The model that actually produced the original output (post-fallback), read from
// the recorded execution trace so the re-run pins the same model.
function originalModelFor(taskId: string): string | null {
  const trace = getPublicTrace(taskId);
  if (!trace) return null;
  const steps = trace.events.filter((e) => e.kind === "step.model" && e.model);
  return steps.length ? (steps[steps.length - 1].model ?? null) : null;
}

const defaultRunner = (ctx: ReproRunContext): Promise<string> =>
  runReproduction(ctx.agent, ctx.message, ctx.maxTokens, {
    model: ctx.model ?? undefined,
    temperature: ctx.temperature ?? undefined,
  });

// Re-run a completed task deterministically and produce (and persist) its
// reproducibility proof.
export async function reproduceTask(taskId: string, opts: ReproduceOptions = {}): Promise<ReproProof> {
  const task = getTaskById(taskId);
  if (!task) throw new ReproError(`task '${taskId}' not found`, 404);
  if (task.status !== "completed" || !task.output) {
    throw new ReproError(`task '${taskId}' has no completed output to reproduce`, 422);
  }
  const agent = getAgentById(task.toAgent);
  if (!agent) throw new ReproError(`runner agent '${task.toAgent}' not found`, 404);
  if (NON_REPRODUCIBLE_AGENTS.has(agent.agentId)) {
    throw new ReproError(
      `task '${taskId}' uses live runtime data (agent '${agent.agentId}') and can't be deterministically reproduced`,
      422,
    );
  }
  // Only tasks that ran on Axon's own inference can be re-run here. Community
  // agents execute on their own external endpoint (the platform worker skips
  // them — workers/index.ts), and MCP agents run via an external MCP server
  // (recorded in the trace as model "mcp"). Neither is reproducible with the
  // local provider, so refuse rather than emit a false-divergent verdict.
  if (agent.endpoint) {
    throw new ReproError(`task '${taskId}' ran on an external agent endpoint and can't be reproduced by Axon`, 422);
  }
  const originalModel = originalModelFor(taskId);
  if (originalModel === "mcp") {
    throw new ReproError(`task '${taskId}' ran via an external MCP server and can't be reproduced by Axon`, 422);
  }

  // Reconstruct the exact recorded input. Live data some agents append at runtime
  // (e.g. market prices) is intentionally NOT replayed — the proof pins the
  // reconstructed input's hash so the method is fully transparent.
  const message = task.task + formatContext(task.context);
  const inputHash = hashOutput(message);

  // The concrete model to re-run with: the one the trace recorded (post-fallback),
  // else the agent's effective default — never a misleading null.
  const model = effectiveModel(agent, originalModel);
  const maxTokens = getAgentMaxTokens(agent.agentId);
  // Temperature 0 where the provider accepts it. Current Claude models deprecate
  // the parameter (the API 400s on it) — there, determinism rests on the pinned
  // model + frozen input, and the proof records null rather than a knob we never set.
  const temperature = agent.provider === "anthropic" ? null : 0;

  const run = opts.runner ?? defaultRunner;
  const reproduced = await run({ agent, message, maxTokens, model, temperature });

  const cmp = compareOutputs(task.output, reproduced);
  const method: ReproMethod = {
    formula:
      "cosine similarity over lowercased [a-z0-9]+ token-frequency vectors, clamped to [0,1] and rounded to 6 decimals; verdict = exact if the output SHA-256 hashes match, else equivalent if similarity >= threshold, else divergent",
    threshold: EQUIVALENCE_THRESHOLD,
    inputHash,
    note: "Lexical (not semantic) equivalence: it measures token overlap, so it does not capture word order or negation. The threshold is empirically calibrated: honest same-task re-runs of current models score 0.62-0.86 (temperature is deprecated on these models, so sampling varies), while answers to different tasks score under 0.48 at the 99th percentile. The task is re-run with the originally-used model at temperature 0 where the provider accepts it (otherwise the proof records temperature null). The reconstructed input excludes any live data appended at runtime. Tasks that did not run on Axon's own inference — agents with live runtime inputs, external endpoints, or MCP servers — are not reproduced at all.",
  };
  const contentHash = hashReproProof({
    taskId,
    verdict: cmp.verdict,
    similarity: cmp.similarity,
    originalOutputHash: cmp.originalOutputHash,
    reproducedOutputHash: cmp.reproducedOutputHash,
    model,
    temperature,
    method,
  });

  const proof: ReproProof = {
    taskId,
    verdict: cmp.verdict,
    similarity: cmp.similarity,
    originalOutputHash: cmp.originalOutputHash,
    reproducedOutputHash: cmp.reproducedOutputHash,
    model,
    temperature,
    method,
    contentHash,
    reproducedAt: new Date().toISOString(),
  };

  if (opts.persist !== false) persistReproProof(proof, reproduced);
  return proof;
}

// ── Persistence ──────────────────────────────────────────────────────────────

interface ReproRow {
  task_id: string;
  verdict: ReproVerdict;
  similarity: number;
  original_output_hash: string;
  reproduced_output_hash: string;
  model: string | null;
  temperature: number | null;
  method: string;
  content_hash: string;
  reproduced_at: string;
}

function rowToProof(row: ReproRow): ReproProof {
  return {
    taskId: row.task_id,
    verdict: row.verdict,
    similarity: row.similarity,
    originalOutputHash: row.original_output_hash,
    reproducedOutputHash: row.reproduced_output_hash,
    model: row.model ?? null,
    temperature: row.temperature ?? null,
    method: JSON.parse(row.method) as ReproMethod,
    contentHash: row.content_hash,
    reproducedAt: row.reproduced_at,
  };
}

function persistReproProof(proof: ReproProof, reproducedOutput: string): void {
  getDb()
    .prepare(
      `INSERT INTO reproducibility_proofs
         (task_id, verdict, similarity, original_output_hash, reproduced_output,
          reproduced_output_hash, model, temperature, method, content_hash, reproduced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         verdict = excluded.verdict,
         similarity = excluded.similarity,
         original_output_hash = excluded.original_output_hash,
         reproduced_output = excluded.reproduced_output,
         reproduced_output_hash = excluded.reproduced_output_hash,
         model = excluded.model,
         temperature = excluded.temperature,
         method = excluded.method,
         content_hash = excluded.content_hash,
         reproduced_at = excluded.reproduced_at`,
    )
    .run(
      proof.taskId,
      proof.verdict,
      proof.similarity,
      proof.originalOutputHash,
      reproducedOutput,
      proof.reproducedOutputHash,
      proof.model,
      proof.temperature,
      JSON.stringify(proof.method),
      proof.contentHash,
      proof.reproducedAt,
    );
  void syncToTurso();
}

// The public, privacy-safe proof for a task — hashes + verdict + similarity +
// method, never the output text. Null when the task hasn't been reproduced.
export function getReproProof(taskId: string): ReproProof | null {
  const row = getDb()
    .prepare(
      `SELECT task_id, verdict, similarity, original_output_hash, reproduced_output_hash,
              model, temperature, method, content_hash, reproduced_at
         FROM reproducibility_proofs WHERE task_id = ?`,
    )
    .get(taskId) as ReproRow | undefined;
  return row ? rowToProof(row) : null;
}
