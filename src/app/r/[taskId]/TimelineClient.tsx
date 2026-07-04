"use client";

import { useEffect, useRef, useState } from "react";

// The replayable execution timeline for a receipt — the front of the "flight
// recorder". Fetches the public, hash-chained trace and lets anyone step through
// it frame by frame. Privacy-safe by construction: the API returns only agents,
// hashes, and model/token/cost/latency metadata.

interface TraceEvent {
  seq: number;
  kind: "task.created" | "step.model" | "progress" | "task.completed" | "task.failed" | "settlement.completed";
  fromAgent: string | null;
  toAgent: string | null;
  fromName: string | null;
  toName: string | null;
  stepIndex: number | null;
  inputHash: string | null;
  outputHash: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  meta: Record<string, unknown> | null;
  hash: string;
  createdAt: string;
}

interface PublicTrace {
  taskId: string;
  traceId: string;
  verified: boolean;
  events: TraceEvent[];
  summary: {
    steps: number;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    totalCostUsd: number | null;
    totalLatencyMs: number | null;
    agents: number;
  };
}

const KIND_META: Record<TraceEvent["kind"], { label: string; dot: string; text: string }> = {
  "task.created": { label: "Task created", dot: "bg-gray-400", text: "text-gray-300" },
  "step.model": { label: "Model step", dot: "bg-teal-400", text: "text-teal-200" },
  progress: { label: "Progress", dot: "bg-sky-400/70", text: "text-sky-200/80" },
  "task.completed": { label: "Completed", dot: "bg-emerald-400", text: "text-emerald-200" },
  "task.failed": { label: "Failed", dot: "bg-red-400", text: "text-red-200" },
  "settlement.completed": { label: "Settled", dot: "bg-amber-400", text: "text-amber-200" },
};

function short(hash: string | null): string {
  if (!hash) return "—";
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}
function fmtLatency(ms: number | null): string | null {
  if (ms == null) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function fmtTokens(n: number | null): string | null {
  if (n == null) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtCost(usd: number | null): string | null {
  if (usd == null) return null;
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export default function TimelineClient({ taskId }: { taskId: string }) {
  const [trace, setTrace] = useState<PublicTrace | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [revealed, setRevealed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/receipts/${encodeURIComponent(taskId)}/trace`);
        if (!alive) return;
        if (res.status === 404) return setState("empty");
        if (!res.ok) return setState("error");
        const data = (await res.json()) as PublicTrace;
        if (!alive) return;
        setTrace(data);
        setRevealed(data.events.length); // show the full trace by default
        setState(data.events.length ? "ready" : "empty");
      } catch {
        if (alive) setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [taskId]);

  // Replay: advance one event at a time; stop at the end.
  useEffect(() => {
    if (!playing || !trace) return;
    timer.current = setInterval(() => {
      setRevealed((r) => {
        if (r >= trace.events.length) {
          setPlaying(false);
          return r;
        }
        return r + 1;
      });
    }, 650);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, trace]);

  function replay() {
    if (!trace) return;
    setRevealed(0);
    setPlaying(true);
  }

  const card = "rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent shadow-2xl overflow-hidden";

  if (state === "loading") {
    return (
      <div className={`${card} mt-5`}>
        <div className="px-7 py-6 text-sm text-gray-500">Loading execution trace…</div>
      </div>
    );
  }
  if (state === "empty" || state === "error") {
    return (
      <div className={`${card} mt-5`}>
        <div className="px-7 py-6 text-sm text-gray-500">
          {state === "error" ? "Couldn't load the execution trace." : "No execution trace was recorded for this task."}
        </div>
      </div>
    );
  }

  const t = trace!;
  const s = t.summary;

  return (
    <div className={`${card} mt-5`}>
      {/* header + chain verification */}
      <div className="px-7 pt-6 pb-4 border-b border-white/10 flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] tracking-[0.3em] font-mono text-teal-400">EXECUTION TRACE</p>
          <p className="text-[11px] text-gray-500 mt-1">Hash-chained flight recorder · {t.events.length} events</p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
            t.verified
              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
              : "bg-red-500/15 text-red-300 border-red-500/40"
          }`}
          title={t.verified ? "Every event's hash recomputes and the chain links are intact." : "The hash chain does not recompute — an event was altered."}
        >
          {t.verified ? "✓ Chain verified" : "✗ Chain broken"}
        </span>
      </div>

      {/* summary chips */}
      <div className="px-7 py-4 flex flex-wrap gap-x-6 gap-y-2 text-sm border-b border-white/10">
        <Stat label="Steps" value={String(s.steps)} />
        {s.agents > 0 && <Stat label="Agents" value={String(s.agents)} />}
        {fmtTokens(s.totalOutputTokens) && <Stat label="Out tokens" value={fmtTokens(s.totalOutputTokens)!} />}
        {fmtLatency(s.totalLatencyMs) && <Stat label="Compute" value={fmtLatency(s.totalLatencyMs)!} />}
        {fmtCost(s.totalCostUsd) && <Stat label="Est. cost" value={fmtCost(s.totalCostUsd)!} />}
      </div>

      {/* replay controls */}
      <div className="px-7 py-3 flex items-center gap-3 border-b border-white/10">
        <button
          onClick={() => (playing ? setPlaying(false) : revealed >= t.events.length ? replay() : setPlaying(true))}
          className="rounded-full bg-teal-500/20 border border-teal-500/40 text-teal-200 text-xs font-semibold px-4 py-1.5 hover:bg-teal-500/30 transition-colors"
        >
          {playing ? "❚❚ Pause" : revealed >= t.events.length ? "▶ Replay" : "▶ Play"}
        </button>
        <input
          type="range"
          min={0}
          max={t.events.length}
          value={revealed}
          onChange={(e) => {
            setPlaying(false);
            setRevealed(Number(e.target.value));
          }}
          className="flex-1 accent-teal-400 h-1"
          aria-label="Scrub execution timeline"
        />
        <span className="text-[11px] font-mono text-gray-500 tabular-nums shrink-0">
          {Math.min(revealed, t.events.length)}/{t.events.length}
        </span>
      </div>

      {/* the timeline */}
      <ol className="px-7 py-5 space-y-0">
        {t.events.map((e, i) => {
          const on = i < revealed;
          const current = i === revealed - 1;
          const km = KIND_META[e.kind];
          const chips = [
            e.model,
            fmtTokens(e.outputTokens) && `${fmtTokens(e.outputTokens)} tok`,
            fmtLatency(e.latencyMs),
            fmtCost(e.costUsd),
            typeof e.meta?.amount === "number" && `${e.meta.amount} ${(e.meta.currency as string) ?? ""}`.trim(),
            typeof e.meta?.errorClass === "string" && (e.meta.errorClass as string),
          ].filter(Boolean) as string[];
          return (
            <li
              key={e.seq}
              className="relative pl-6 pb-5 last:pb-0 transition-all duration-300"
              style={{ opacity: on ? 1 : 0.25, transform: on ? "none" : "translateY(4px)" }}
            >
              {/* connector line */}
              {i < t.events.length - 1 && <span className="absolute left-[5px] top-3 bottom-0 w-px bg-white/10" />}
              {/* dot */}
              <span className={`absolute left-0 top-1.5 h-[11px] w-[11px] rounded-full ${km.dot} ${current ? "ring-4 ring-white/10" : ""}`} />
              <div className="flex items-center justify-between gap-3">
                <p className={`text-sm font-semibold ${km.text}`}>
                  {km.label}
                  {e.kind === "step.model" && e.stepIndex != null && (
                    <span className="text-gray-500 font-normal"> · step {e.stepIndex + 1}</span>
                  )}
                </p>
                <span className="text-[10px] font-mono text-gray-600 shrink-0">#{e.seq}</span>
              </div>
              {(e.fromName || e.toName || e.toAgent) && (e.kind === "step.model" || e.kind === "task.created") && (
                <p className="text-xs text-gray-400 mt-0.5">
                  {e.fromName ?? e.fromAgent ?? "—"} <span className="text-teal-500">→</span> {e.toName ?? e.toAgent ?? "—"}
                </p>
              )}
              {chips.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {chips.map((c, k) => (
                    <span key={k} className="text-[10px] font-mono text-gray-400 rounded bg-white/[0.05] border border-white/10 px-1.5 py-0.5">
                      {c}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[10px] font-mono text-gray-600 mt-1 break-all" title={e.hash}>
                {short(e.hash)}
              </p>
            </li>
          );
        })}
      </ol>

      <div className="px-7 py-3 bg-white/[0.03] border-t border-white/10">
        <p className="text-[11px] text-gray-500">
          Each event commits to the previous event&apos;s hash — altering any past step breaks the chain. Content stays private; only hashes are shown.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500">{label}: </span>
      <span className="text-white font-semibold font-mono">{value}</span>
    </div>
  );
}
