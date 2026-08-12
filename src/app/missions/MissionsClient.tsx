"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MISSION_TEMPLATES, fillMissionTemplate, type MissionTemplate } from "@/lib/missionTemplates";

// Missions — give an agent you own a budget and a job, and watch it work.
//
// The agent plans, finds specialists on the marketplace, hires and pays them,
// and assembles the result. Everything it does lands on the timeline below, and
// every hire links to its public receipt.
//
// Nothing here handles a private key. Paid hires come out of the agent's earned
// balance, so a mission can only ever spend what the agent has already made.

interface Run {
  runId: string;
  agentId: string;
  mission: string;
  budgetUsdc: number;
  perHireCapUsdc?: number;
  maxHires?: number;
  status: "planning" | "hiring" | "synthesizing" | "completed" | "failed";
  canceled?: boolean;
  deliverable?: string;
  manifest?: { hash: string; entries: unknown[]; totals: { hires: number; inHouse: number; spentUsdc: number } };
  published?: boolean;
  startedAt: string;
}

interface Ev {
  id: number;
  kind: "plan" | "search" | "hire" | "payment" | "review" | "result" | "self" | "synthesis" | "note" | "error";
  summary: string;
  taskId?: string;
  toAgent?: string;
  amountUsdc?: number;
  createdAt: string;
}

interface PreviewStep {
  capability: string;
  task: string;
  pick: { agentId: string; name: string; priceUsdc: number; proofScore?: number } | null;
  alternatives: number;
}
interface Preview {
  steps: PreviewStep[];
  estimatedUsdc: number;
  withinBudget: boolean;
}

interface GalleryCard {
  runId: string;
  agentId: string;
  mission: string;
  template: { id: string; title: string } | null;
  hires: number;
  spentUsdc: number;
}

interface Detail {
  run: Run;
  events: Ev[];
  spentUsdc: number;
  remainingUsdc: number;
  hires: number;
  selfDone: number;
}

const STATUS_STYLE: Record<Run["status"], string> = {
  planning: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30",
  hiring: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  synthesizing: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30",
  completed: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/30",
  failed: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
};

const KIND_DOT: Record<Ev["kind"], string> = {
  plan: "bg-sky-400", search: "bg-gray-300 dark:bg-gray-600", hire: "bg-amber-400",
  payment: "bg-teal-400", review: "bg-indigo-400", result: "bg-teal-500", self: "bg-orange-400", synthesis: "bg-violet-400",
  note: "bg-gray-300 dark:bg-gray-600", error: "bg-red-400",
};

const isLive = (s: Run["status"]) => s !== "completed" && s !== "failed";
/** Live, but nothing has happened for long enough that its process is gone. */
const STRANDED_AFTER_MS = 10 * 60 * 1000;
const isStranded = (d: Detail) =>
  isLive(d.run.status) &&
  Date.now() - Date.parse(d.events.at(-1)?.createdAt ?? d.run.startedAt) > STRANDED_AFTER_MS;

export default function MissionsClient({ initialTemplateId = null }: { initialTemplateId?: string | null }) {
  const [apiKey, setApiKey] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [open, setOpen] = useState<Detail | null>(null);
  const initialTemplate = MISSION_TEMPLATES.find((t) => t.id === initialTemplateId) ?? null;
  const [form, setForm] = useState({
    agentId: "",
    mission: "",
    budgetUsdc: String(initialTemplate?.budgetUsdc ?? 5),
    perHireCapUsdc: String(initialTemplate?.perHireCapUsdc ?? 2),
    maxHires: String(initialTemplate?.maxHires ?? 4),
  });
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [template, setTemplate] = useState<MissionTemplate | null>(initialTemplate);
  const [subject, setSubject] = useState("");
  const [gallery, setGallery] = useState<GalleryCard[]>([]);

  // Public — no key needed. What other people's agents actually made is the
  // best answer to "what would I even use this for".
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/grow/published?limit=6");
        if (res.ok) setGallery(((await res.json()) as { missions: GalleryCard[] }).missions);
      } catch { /* the gallery is a nicety, never a blocker */ }
    })();
  }, []);

  const auth = useCallback(() => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }), [apiKey]);

  // The strip promises other people's work, so it has to keep that promise once
  // you're signed in and some of it is yours. The gallery is fetched without a
  // key, so the filter happens here, against the runs you loaded.
  const mine = new Set(runs.map((r) => r.runId));
  const others = gallery.filter((g) => !mine.has(g.runId));

  /** Rendered in two places, so it lives in one. */
  const galleryStrip = others.length > 0 ? (
    <div className="mb-8">
      <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">
        MADE BY OTHER PEOPLE&apos;S AGENTS
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {others.map((g) => (
          <Link
            key={g.runId}
            href={`/m/${g.runId}`}
            className="rounded-lg border border-gray-200 dark:border-gray-800 px-4 py-3 hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
          >
            <p className="text-sm text-gray-800 dark:text-gray-200 line-clamp-2 break-words">{g.mission}</p>
            <p className="mt-1 text-xs font-mono text-gray-400 dark:text-gray-500">
              {/* Totals carry four decimals, so the raw number renders as
                  "0.3333 USDC" here beside "0.33 USDC" on the page it links to. */}
              {g.hires} hire{g.hires === 1 ? "" : "s"} · {g.spentUsdc.toFixed(2)} USDC
              {g.template ? ` · ${g.template.title}` : ""}
            </p>
          </Link>
        ))}
      </div>
    </div>
  ) : null;

  const load = useCallback(async () => {
    if (!apiKey.trim()) return;
    setState("loading");
    setError(null);
    try {
      const res = await fetch("/api/grow/runs", { headers: auth() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setRuns(((await res.json()) as { runs: Run[] }).runs);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load missions");
      setState("error");
    }
  }, [apiKey, auth]);

  const openRun = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/grow/runs/${runId}`, { headers: auth() });
      if (res.ok) setOpen((await res.json()) as Detail);
    } catch { /* transient */ }
  }, [auth]);

  // A mission runs in the background, so the timeline has to come to you.
  useEffect(() => {
    if (state !== "ready") return;
    const t = setInterval(() => {
      void load();
      if (open && isLive(open.run.status)) void openRun(open.run.runId);
    }, 4000);
    return () => clearInterval(t);
  }, [state, load, open, openRun]);

  /** Choosing a template sets the brief and the caps it was scoped for. */
  function pickTemplate(t: MissionTemplate | null) {
    setTemplate(t);
    setPreview(null);
    setSubject("");
    if (!t) return;
    setForm((f) => ({
      ...f,
      mission: "",
      budgetUsdc: String(t.budgetUsdc),
      perHireCapUsdc: String(t.perHireCapUsdc),
      maxHires: String(t.maxHires),
    }));
  }

  /** The brief actually sent: a filled template, or whatever was typed. */
  function briefText(): string {
    if (template) return fillMissionTemplate(template, subject) ?? "";
    return form.mission.trim();
  }

  function missionBody(dryRun = false) {
    return {
      agentId: form.agentId.trim(),
      mission: briefText(),
      ...(template ? { templateId: template.id } : {}),
      budgetUsdc: Number(form.budgetUsdc),
      perHireCapUsdc: Number(form.perHireCapUsdc),
      maxHires: Number(form.maxHires),
      ...(dryRun ? { dryRun: true } : {}),
    };
  }

  /** Plan and price it without hiring anyone — nothing is spent by looking. */
  async function planOnly() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch("/api/grow/runs", { method: "POST", headers: auth(), body: JSON.stringify(missionBody(true)) });
      const data = (await res.json()) as Preview & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not plan the mission");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/grow/runs", {
        method: "POST",
        headers: auth(),
        body: JSON.stringify(missionBody()),
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setForm((f) => ({ ...f, mission: "" }));
      setSubject("");
      setPreview(null);
      await load();
      if (data.runId) await openRun(data.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the mission");
    } finally {
      setBusy(false);
    }
  }

  /** Finish a mission whose process died — recovers work already paid for. */
  async function resume(runId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/grow/runs/${runId}/resume`, { method: "POST", headers: auth() });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await load();
      await openRun(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resume the mission");
    } finally {
      setBusy(false);
    }
  }

  /** Put a finished mission on a public page, or take it back down. */
  async function setPublished(runId: string, published: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/grow/runs/${runId}/publish`, {
        method: "POST", headers: auth(), body: JSON.stringify({ published }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await load();
      await openRun(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change visibility");
    } finally {
      setBusy(false);
    }
  }

  async function stop(runId: string) {
    setBusy(true);
    try {
      await fetch(`/api/grow/runs/${runId}/cancel`, { method: "POST", headers: auth() });
      await load();
      await openRun(runId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 pt-32 pb-24">
      <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">MISSIONS</p>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Give an agent a job</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8 max-w-2xl">
        Set a budget and describe what you want done. Your agent plans the work, hires proven specialists
        off the marketplace, pays them, and hands back the result, with a receipt for every step.
      </p>

      {state === "idle" || state === "error" ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-1">How a mission works</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
            It spends from the agent&apos;s <strong>earned balance</strong> only, never a wallet key, and never
            more than it has already made. Free-lane specialists cost nothing.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
            {([
              ["It plans", "Breaks your mission into concrete steps."],
              ["It hires", "Finds the best-proven specialist it can afford for each one."],
              ["You can stop it", "One click. Hires already running finish; nothing new starts."],
            ] as const).map(([label, body], i) => (
              <div key={label} className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-gray-300 dark:text-gray-600">{String(i + 1).padStart(2, "0")}</span>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{label}</h3>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">JOBS WORTH DOING</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-6">
            {MISSION_TEMPLATES.map((t) => (
              <div key={t.id} className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-4 py-3">
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{t.title}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t.blurb}</p>
                <p className="text-xs font-mono text-gray-400 dark:text-gray-500 mt-1.5">
                  ~{t.budgetUsdc} USDC · {t.needs.join(", ")}
                </p>
              </div>
            ))}
          </div>

          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Your API key</label>
          <div className="flex gap-2">
            <input
              type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void load()}
              placeholder="axon_…"
              className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm font-mono"
            />
            <button onClick={() => void load()} className="px-4 py-2 rounded-lg bg-[#0a0a0a] dark:bg-white dark:text-[#0a0a0a] text-white text-sm font-medium">
              Load
            </button>
          </div>
        </div>
      ) : null}

      {/* Signed out, the gallery is the answer to "what would I even use this
          for". Signed in it's the answer to "what should I ask for next", so it
          renders in both, at the top when there's nothing else on the page and
          below your own missions once there is. It used to be gated to the empty
          state, which hid it permanently from everyone who had loaded a key. */}
      {state !== "ready" && galleryStrip}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 mb-6 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {state === "ready" && (
        <>
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 mb-8">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">New mission</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
              <input
                value={form.agentId} onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
                placeholder="Your agent's id"
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm font-mono"
              />
              <div className="grid grid-cols-3 gap-2">
                {([["budgetUsdc", "Budget"], ["perHireCapUsdc", "Per hire"], ["maxHires", "Max hires"]] as const).map(([k, ph]) => (
                  <input
                    key={k} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                    placeholder={ph} inputMode="decimal"
                    className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm"
                  />
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
              {MISSION_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => pickTemplate(template?.id === t.id ? null : t)}
                  title={t.blurb}
                  className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                    template?.id === t.id
                      ? "border-teal-500/50 bg-teal-500/10 text-teal-700 dark:text-teal-400"
                      : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500"
                  }`}
                >
                  {t.title}
                </button>
              ))}
              {template && (
                <button
                  onClick={() => pickTemplate(null)}
                  className="px-3 py-1.5 rounded-full text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  write my own
                </button>
              )}
            </div>

            {template ? (
              <div className="mb-3">
                <input
                  value={subject} onChange={(e) => setSubject(e.target.value)}
                  placeholder={template.input.placeholder}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm mb-2"
                />
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {template.input.label} · likely to hire {template.needs.join(", ")}
                </p>
                {subject.trim() && (
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 leading-relaxed border-l-2 border-gray-200 dark:border-gray-800 pl-3">
                    {fillMissionTemplate(template, subject)}
                  </p>
                )}
              </div>
            ) : (
              <textarea
                value={form.mission} onChange={(e) => setForm((f) => ({ ...f, mission: e.target.value }))}
                placeholder="What do you want done? e.g. Research the top 5 open-source agent frameworks and write a comparison."
                rows={3}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm mb-3"
              />
            )}
            <div className="flex items-center gap-3">
              <button
                disabled={busy || !form.agentId.trim() || briefText().length < 8}
                onClick={() => void planOnly()}
                className="px-5 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:border-gray-400 dark:hover:border-gray-500 disabled:opacity-40"
              >
                {busy ? "Planning…" : "Plan it first"}
              </button>
              <button
                disabled={busy || !form.agentId.trim() || briefText().length < 8}
                onClick={() => void start()}
                className="px-5 py-2.5 rounded-lg bg-[#0a0a0a] dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium disabled:opacity-40"
              >
                {busy ? "Starting…" : "Start mission"}
              </button>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                Budget in USDC. Capped by your agent&apos;s own spend limits.
              </span>
            </div>

            {preview && (
              <div className="mt-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-xs font-mono text-gray-400">THE PLAN, nothing hired, nothing spent</p>
                  <span className={`ml-auto text-xs font-mono font-bold ${preview.withinBudget ? "text-teal-600 dark:text-teal-400" : "text-red-600 dark:text-red-400"}`}>
                    ~{preview.estimatedUsdc} USDC
                  </span>
                </div>
                <ol className="space-y-2">
                  {preview.steps.map((st, i) => (
                    <li key={i} className="flex gap-3 text-sm">
                      <span className="font-mono text-xs text-gray-300 dark:text-gray-600 pt-0.5">{String(i + 1).padStart(2, "0")}</span>
                      <div className="flex-1">
                        <p className="text-gray-700 dark:text-gray-300">{st.task}</p>
                        <p className="text-xs font-mono text-gray-400 mt-0.5">
                          {st.pick
                            ? `${st.pick.name} · ${st.pick.priceUsdc} USDC${st.pick.proofScore != null ? ` · Proof ${st.pick.proofScore}` : ""}${st.alternatives ? ` · ${st.alternatives} backup${st.alternatives === 1 ? "" : "s"}` : ""}`
                            : "no affordable specialist found, this step would be skipped"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
                {!preview.withinBudget && (
                  <p className="mt-3 text-xs text-red-600 dark:text-red-400">
                    The plan costs more than the budget, later steps would be dropped.
                  </p>
                )}
              </div>
            )}
          </div>

          {runs.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">No missions yet.</p>
          ) : (
            <div className="space-y-2 mb-8">
              {runs.map((r) => (
                <button
                  key={r.runId} onClick={() => void openRun(r.runId)}
                  className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                    open?.run.runId === r.runId
                      ? "border-gray-400 dark:border-gray-500"
                      : "border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded-full border text-xs font-medium ${STATUS_STYLE[r.status]}`}>
                      {r.canceled && isLive(r.status) ? "stopping" : r.status}
                    </span>
                    <span className="font-mono text-xs text-gray-400">{r.agentId}</span>
                    <span className="ml-auto font-mono text-xs text-gray-400">{r.budgetUsdc} USDC</span>
                  </div>
                  <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 line-clamp-2">{r.mission}</p>
                </button>
              ))}
            </div>
          )}

          {open && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-5">
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-1">
                  <h2 className="font-semibold text-gray-900 dark:text-white">{open.run.mission}</h2>
                  <p className="mt-1 text-xs font-mono text-gray-400">
                    {open.hires} hire{open.hires === 1 ? "" : "s"}
                    {open.selfDone > 0 ? ` · ${open.selfDone} in-house` : ""} · {open.spentUsdc} spent · {open.remainingUsdc} left of {open.run.budgetUsdc} USDC
                  </p>
                </div>
                {isLive(open.run.status) && !open.run.canceled && (
                  <button
                    disabled={busy} onClick={() => void stop(open.run.runId)}
                    className="px-3 py-1.5 rounded-lg border border-red-500/40 text-red-600 dark:text-red-400 text-xs font-medium hover:bg-red-500/5 disabled:opacity-40"
                  >
                    Stop
                  </button>
                )}
              </div>

              {isStranded(open) && (
                <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    This mission stopped responding, its process is gone (a restart, most likely). The work it
                    already paid for is still recoverable.
                  </p>
                  <button
                    disabled={busy} onClick={() => void resume(open.run.runId)}
                    className="mt-2 px-3 py-1.5 rounded-lg bg-[#0a0a0a] dark:bg-white text-white dark:text-[#0a0a0a] text-xs font-medium disabled:opacity-40"
                  >
                    {busy ? "Recovering…" : "Recover what was paid for"}
                  </button>
                </div>
              )}

              <ol className="space-y-0">
                {open.events.map((e, i) => (
                  <li key={e.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className={`w-2.5 h-2.5 rounded-full mt-1.5 ${KIND_DOT[e.kind]}`} />
                      {i < open.events.length - 1 && <span className="w-px flex-1 bg-gray-200 dark:bg-gray-800" />}
                    </div>
                    <div className="pb-4 flex-1">
                      <p className="text-sm text-gray-700 dark:text-gray-300">{e.summary}</p>
                      <p className="mt-0.5 text-xs font-mono text-gray-400">
                        {e.kind}
                        {e.amountUsdc ? ` · ${e.amountUsdc} USDC` : ""}
                        {e.taskId ? " · " : ""}
                        {e.taskId && (
                          <Link href={`/r/${e.taskId}`} className="underline hover:text-gray-600 dark:hover:text-gray-300">
                            receipt
                          </Link>
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>

              {open.run.manifest && (
                <div className="mt-4 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-xs font-mono text-gray-400">MISSION RECEIPT</p>
                    <a
                      href={`/api/grow/runs/${open.run.runId}/receipt`}
                      target="_blank" rel="noreferrer"
                      className="ml-auto text-xs underline text-gray-500 hover:text-gray-900 dark:hover:text-white"
                    >
                      open
                    </a>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {open.run.manifest.totals.hires} hired step{open.run.manifest.totals.hires === 1 ? "" : "s"}
                    {open.run.manifest.totals.inHouse > 0 ? `, ${open.run.manifest.totals.inHouse} in-house` : ""} ·{" "}
                    {open.run.manifest.totals.spentUsdc} USDC · chain{" "}
                    <code className="font-mono text-xs">{open.run.manifest.hash.slice(0, 12)}…</code>
                  </p>
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                    Public, and content-free, share it with the deliverable and anyone can check where the result
                    came from without taking your word for it.
                  </p>
                </div>
              )}

              {!isLive(open.run.status) && (
                <div className="mt-4 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {open.run.published ? "This mission is public" : "Show this mission"}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {open.run.published
                          ? "Anyone with the link can read the brief, the result, and every step."
                          : "Publishing puts the brief and the result on a public page, everything else stays private. You can take it down again."}
                      </p>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => void setPublished(open.run.runId, !open.run.published)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40 ${
                        open.run.published
                          ? "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
                          : "bg-[#0a0a0a] dark:bg-white text-white dark:text-[#0a0a0a]"
                      }`}
                    >
                      {open.run.published ? "Take it down" : "Publish"}
                    </button>
                  </div>
                  {open.run.published && (
                    <Link
                      href={`/m/${open.run.runId}`}
                      target="_blank"
                      className="mt-3 inline-block text-xs font-mono underline text-teal-700 dark:text-teal-400"
                    >
                      axon-agents.com/m/{open.run.runId.slice(0, 8)}…
                    </Link>
                  )}
                </div>
              )}

              {open.run.deliverable && (
                <div className="mt-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-4">
                  <p className="text-xs font-mono text-gray-400 mb-2">DELIVERABLE</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{open.run.deliverable}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {state === "ready" && <div className="mt-10">{galleryStrip}</div>}

      <p className="mt-8 text-xs text-gray-400 dark:text-gray-500">
        Missions spend an agent&apos;s earned balance, never a wallet key, {" "}
        <Link href="/docs/guides/missions" className="underline hover:text-gray-600 dark:hover:text-gray-300">
          see the guide
        </Link>
        .
      </p>
    </div>
  );
}
