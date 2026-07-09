import { createHash } from "crypto";
import { getDb } from "./db";
import { logger } from "./logger";

// Verifiable execution traces — the "flight recorder".
//
// An append-only, hash-chained log of everything that happened for a trace.
// Each event commits to the previous event's hash, so tampering with any past
// event breaks the chain from that point on — a receipt's timeline is provable
// without trusting the platform. Privacy matches receipts: hashes + small
// content-free metadata only, never task content or output text.

export type TraceEventKind =
  | "task.created"
  | "step.model"
  | "progress"
  | "task.completed"
  | "task.failed"
  | "settlement.completed";

export interface TraceEventInput {
  traceId: string;
  taskId?: string | null;
  kind: TraceEventKind;
  fromAgent?: string | null;
  toAgent?: string | null;
  workflowId?: string | null;
  stepIndex?: number | null;
  inputHash?: string | null;
  outputHash?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  meta?: Record<string, unknown> | null;
}

export interface TraceEvent {
  seq: number;
  taskId: string | null;
  kind: TraceEventKind;
  fromAgent: string | null;
  toAgent: string | null;
  workflowId: string | null;
  stepIndex: number | null;
  inputHash: string | null;
  outputHash: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  meta: Record<string, unknown> | null;
  prevHash: string | null;
  hash: string;
  createdAt: string;
}

interface TraceRow {
  trace_id: string;
  seq: number;
  task_id: string | null;
  kind: TraceEventKind;
  from_agent: string | null;
  to_agent: string | null;
  workflow_id: string | null;
  step_index: number | null;
  input_hash: string | null;
  output_hash: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  meta: string | null; // canonical JSON string, exactly as hashed
  prev_hash: string | null;
  hash: string;
  created_at: string;
}

// ── Canonical hashing ─────────────────────────────────────────────────────────

// Deterministic JSON: keys sorted recursively, undefined dropped. Matches the
// intent of AgenC's json-stable-v1 scheme so event hashing is order-independent.
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Hash arbitrary content (task input / output) — one-way, so storing it leaks
// nothing while still proving what was processed.
export function hashContent(content: string | null | undefined): string | null {
  if (content == null) return null;
  return sha256hex(content);
}

// The exact field set that goes into an event's hash. Built identically on write
// and on verify (from the stored row) so the chain recomputes deterministically.
function hashPayload(fields: {
  traceId: string;
  seq: number;
  taskId: string | null;
  kind: string;
  fromAgent: string | null;
  toAgent: string | null;
  workflowId: string | null;
  stepIndex: number | null;
  inputHash: string | null;
  outputHash: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  meta: string | null;
  createdAt: string;
  prevHash: string | null;
}): string {
  return canonicalStringify(fields);
}

// ── Cost estimation ───────────────────────────────────────────────────────────

// USD per 1M tokens. Best-effort — a static table, matched by model-id prefix so
// dated suffixes (…-20251001) still resolve. Unknown models yield a null cost.
const MODEL_PRICES: { prefix: string; in: number; out: number }[] = [
  { prefix: "claude-opus-4-8", in: 5, out: 25 },
  { prefix: "claude-opus-4-7", in: 5, out: 25 },
  { prefix: "claude-opus-4-6", in: 5, out: 25 },
  { prefix: "claude-sonnet-5", in: 3, out: 15 },
  { prefix: "claude-sonnet-4-6", in: 3, out: 15 },
  { prefix: "claude-haiku-4-5", in: 1, out: 5 },
  { prefix: "claude-fable-5", in: 10, out: 50 },
  { prefix: "claude-mythos-5", in: 10, out: 50 },
  { prefix: "grok-4.20", in: 2, out: 6 },
  { prefix: "grok-4.3", in: 1.25, out: 2.5 },
];

export function estimateCostUsd(
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number | null {
  if (!model || inputTokens == null || outputTokens == null) return null;
  const price = MODEL_PRICES.find((p) => model.startsWith(p.prefix));
  if (!price) return null;
  const cost = (inputTokens / 1_000_000) * price.in + (outputTokens / 1_000_000) * price.out;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ── Append ────────────────────────────────────────────────────────────────────

// Resolve the trace a task belongs to (falls back to the task id itself, matching
// resolveTraceId's behaviour for un-grouped tasks).
export function traceIdForTask(taskId: string): string {
  const row = getDb().prepare("SELECT trace_id FROM tasks WHERE task_id = ?").get(taskId) as
    | { trace_id: string | null }
    | undefined;
  return row?.trace_id ?? taskId;
}

// Append one event to a trace's hash chain. Atomic: reading the chain head and
// inserting the new link run in a single synchronous transaction, so concurrent
// task processing can't interleave and fork the chain.
export function appendTraceEvent(input: TraceEventInput): void {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const metaStr = input.meta ? canonicalStringify(input.meta) : null;

  db.transaction(() => {
    const head = db
      .prepare("SELECT seq, hash FROM trace_events WHERE trace_id = ? ORDER BY seq DESC LIMIT 1")
      .get(input.traceId) as { seq: number; hash: string } | undefined;
    const seq = (head?.seq ?? 0) + 1;
    const prevHash = head?.hash ?? null;

    const hash = sha256hex(
      hashPayload({
        traceId: input.traceId,
        seq,
        taskId: input.taskId ?? null,
        kind: input.kind,
        fromAgent: input.fromAgent ?? null,
        toAgent: input.toAgent ?? null,
        workflowId: input.workflowId ?? null,
        stepIndex: input.stepIndex ?? null,
        inputHash: input.inputHash ?? null,
        outputHash: input.outputHash ?? null,
        model: input.model ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        costUsd: input.costUsd ?? null,
        latencyMs: input.latencyMs ?? null,
        meta: metaStr,
        createdAt,
        prevHash,
      }),
    );

    db.prepare(
      `INSERT INTO trace_events
         (trace_id, seq, task_id, kind, from_agent, to_agent, workflow_id, step_index,
          input_hash, output_hash, model, input_tokens, output_tokens, cost_usd, latency_ms,
          meta, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.traceId,
      seq,
      input.taskId ?? null,
      input.kind,
      input.fromAgent ?? null,
      input.toAgent ?? null,
      input.workflowId ?? null,
      input.stepIndex ?? null,
      input.inputHash ?? null,
      input.outputHash ?? null,
      input.model ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.costUsd ?? null,
      input.latencyMs ?? null,
      metaStr,
      prevHash,
      hash,
      createdAt,
    );
  })();
}

// Trace capture is observability — a failure here must never break a task,
// settlement, or model call. Swallow and log.
export function safeAppendTraceEvent(input: TraceEventInput): void {
  try {
    appendTraceEvent(input);
  } catch (err) {
    logger.error("trace.append_failed", "Failed to append trace event", {
      err,
      traceId: input.traceId,
      taskId: input.taskId,
      kind: input.kind,
    });
  }
}

// ── Read + verify ─────────────────────────────────────────────────────────────

function rowToEvent(r: TraceRow): TraceEvent {
  return {
    seq: r.seq,
    taskId: r.task_id,
    kind: r.kind,
    fromAgent: r.from_agent,
    toAgent: r.to_agent,
    workflowId: r.workflow_id,
    stepIndex: r.step_index,
    inputHash: r.input_hash,
    outputHash: r.output_hash,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    latencyMs: r.latency_ms,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
    prevHash: r.prev_hash,
    hash: r.hash,
    createdAt: r.created_at,
  };
}

export function getTraceEvents(traceId: string): TraceEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM trace_events WHERE trace_id = ? ORDER BY seq ASC")
    .all(traceId) as TraceRow[];
  return rows.map(rowToEvent);
}

export interface ChainVerification {
  valid: boolean;
  count: number;
  brokenAt: number | null; // seq of the first event whose hash/link doesn't recompute
}

// Recompute every event's hash from its stored fields and confirm the chain links
// (prev_hash matches the prior event's hash, seq is contiguous). Any tamper with a
// past event surfaces here as brokenAt.
export function verifyTraceChain(traceId: string): ChainVerification {
  const rows = getDb()
    .prepare("SELECT * FROM trace_events WHERE trace_id = ? ORDER BY seq ASC")
    .all(traceId) as TraceRow[];

  let prevHash: string | null = null;
  let expectedSeq = 1;
  for (const r of rows) {
    const recomputed = sha256hex(
      hashPayload({
        traceId: r.trace_id,
        seq: r.seq,
        taskId: r.task_id,
        kind: r.kind,
        fromAgent: r.from_agent,
        toAgent: r.to_agent,
        workflowId: r.workflow_id,
        stepIndex: r.step_index,
        inputHash: r.input_hash,
        outputHash: r.output_hash,
        model: r.model,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUsd: r.cost_usd,
        latencyMs: r.latency_ms,
        meta: r.meta,
        createdAt: r.created_at,
        prevHash: r.prev_hash,
      }),
    );
    if (r.seq !== expectedSeq || r.prev_hash !== prevHash || r.hash !== recomputed) {
      return { valid: false, count: rows.length, brokenAt: r.seq };
    }
    prevHash = r.hash;
    expectedSeq += 1;
  }
  return { valid: true, count: rows.length, brokenAt: null };
}

// ── Public trace (for the shareable receipt timeline) ─────────────────────────

export interface PublicTraceEvent extends TraceEvent {
  fromName: string | null;
  toName: string | null;
}

export interface PublicTrace {
  taskId: string;
  traceId: string;
  verified: boolean;
  events: PublicTraceEvent[];
  summary: {
    steps: number; // step.model events
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    totalCostUsd: number | null;
    totalLatencyMs: number | null;
    agents: number; // distinct agents that performed work
  };
}

// Everything the /r/<taskId> timeline needs. Same privacy face as PublicReceipt:
// agents, hashes, model/token/cost/latency metadata — never content.
export function getPublicTrace(taskId: string): PublicTrace | null {
  const db = getDb();
  const traceId = traceIdForTask(taskId);
  const events = getTraceEvents(traceId);
  if (events.length === 0) return null;

  const nameCache = new Map<string, string | null>();
  const nameOf = (id: string | null): string | null => {
    if (!id) return null;
    if (nameCache.has(id)) return nameCache.get(id)!;
    const a = db.prepare("SELECT name FROM agents WHERE agent_id = ?").get(id) as { name: string } | undefined;
    const name = a?.name ?? null;
    nameCache.set(id, name);
    return name;
  };

  const steps = events.filter((e) => e.kind === "step.model");
  const sum = (pick: (e: TraceEvent) => number | null): number | null => {
    const vals = steps.map(pick).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const workers = new Set(steps.map((e) => e.toAgent).filter(Boolean) as string[]);

  return {
    taskId,
    traceId,
    verified: verifyTraceChain(traceId).valid,
    events: events.map((e) => ({ ...e, fromName: nameOf(e.fromAgent), toName: nameOf(e.toAgent) })),
    summary: {
      steps: steps.length,
      totalInputTokens: sum((e) => e.inputTokens),
      totalOutputTokens: sum((e) => e.outputTokens),
      totalCostUsd: (() => {
        const c = sum((e) => e.costUsd);
        return c == null ? null : Math.round(c * 1_000_000) / 1_000_000;
      })(),
      totalLatencyMs: sum((e) => e.latencyMs),
      agents: workers.size,
    },
  };
}

// Model-usage side-channel lives in ./modelUsage (dependency-free, off the DB
// path); re-exported here so callers have one trace surface to import from.
export { recordModelUsage, captureModelStep } from "./modelUsage";
export type { CapturedStep } from "./modelUsage";
