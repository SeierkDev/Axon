"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

type TaskStatus = "payment_pending" | "queued" | "running" | "completed" | "failed";

type WorkflowStep = {
  stepIndex: number;
  agentId: string;
  taskId: string;
  status: TaskStatus;
  input: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

type Workflow = {
  workflowId: string;
  fromAgent: string;
  agents: string[];
  initialTask: string;
  status: "running" | "completed" | "failed";
  currentStep: number;
  steps: WorkflowStep[];
  finalOutput?: string;
  createdAt: string;
  completedAt?: string;
};

const STORAGE_KEY = "axon.dashboard.apiKey";

const STEP_STYLE: Record<TaskStatus, string> = {
  payment_pending: "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-900 dark:bg-purple-950/30 dark:text-purple-400",
  queued: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400",
  running: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400",
  completed: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-400",
  failed: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400",
};

const WORKFLOW_STYLE: Record<Workflow["status"], string> = {
  running: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400",
  completed: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-400",
  failed: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400",
};

function short(id: string) {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function StepConnector({ active }: { active: boolean }) {
  return (
    <div className={`w-px h-6 mx-auto my-1 transition-colors ${active ? "bg-gray-300 dark:bg-gray-600" : "bg-gray-100 dark:bg-gray-800"}`} />
  );
}

export default function WorkflowClient({ workflowId }: { workflowId: string }) {
  const [apiKey, setApiKey] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    if (!key.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
      });
      const body = await res.json() as Workflow & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Status ${res.status}`);
      setWorkflow(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load workflow");
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY) ?? "";
    if (!saved) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setApiKey(saved);
    setDraftKey(saved);
    void load(saved);
  }, [load]);

  function submit() {
    const key = draftKey.trim();
    window.localStorage.setItem(STORAGE_KEY, key);
    setApiKey(key);
    void load(key);
  }

  const shortId = workflowId.length > 14
    ? `${workflowId.slice(0, 8)}…${workflowId.slice(-6)}`
    : workflowId;

  return (
    <>
      {/* Auth bar */}
      {!workflow && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-5 mb-8">
          <p className="text-sm font-medium text-gray-900 dark:text-white mb-3">
            Workflow data is private — authenticate to view it
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="axon_sk…"
              className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 outline-none focus:border-gray-500"
              autoFocus
            />
            <button
              onClick={submit}
              disabled={!draftKey.trim() || loading}
              className="px-4 py-2 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-40 transition-colors"
            >
              {loading ? "Loading…" : "Load"}
            </button>
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{error}</p>}
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
            Your key must belong to the sender or one agent in the chain.{" "}
            <Link href="/dashboard" className="underline hover:text-gray-700 dark:hover:text-white">Go to dashboard</Link>
          </p>
        </div>
      )}

      {loading && !workflow && (
        <div className="text-sm text-gray-400 py-8 text-center">Loading workflow…</div>
      )}

      {workflow && (
        <>
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${WORKFLOW_STYLE[workflow.status]}`}>
                  {workflow.status}
                </span>
                <span className="text-xs font-mono text-gray-400">{shortId}</span>
              </div>
              <p className="text-sm text-gray-700 dark:text-gray-300 max-w-xl">{workflow.initialTask}</p>
            </div>
            <div className="text-right text-xs text-gray-400 shrink-0">
              <p>Started {dateTime(workflow.createdAt)}</p>
              {workflow.completedAt && <p>Finished {dateTime(workflow.completedAt)}</p>}
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            {[
              { label: "Agents", value: String(workflow.agents.length) },
              { label: "Current step", value: `${Math.min(workflow.currentStep + 1, workflow.agents.length)} / ${workflow.agents.length}` },
              { label: "Sender", value: short(workflow.fromAgent) },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-gray-200 dark:border-gray-800 p-4">
                <p className="text-lg font-semibold text-gray-900 dark:text-white font-mono">{s.value}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Step chain */}
          <div className="mb-8">
            <h2 className="font-semibold text-gray-900 dark:text-white mb-4">Agent chain</h2>
            <div className="space-y-0">
              {workflow.agents.map((agentId, idx) => {
                const step = workflow.steps.find((s) => s.stepIndex === idx);
                const isActive = idx === workflow.currentStep && workflow.status === "running";
                return (
                  <div key={`${agentId}-${idx}`}>
                    <div className={`rounded-lg border p-4 transition-colors ${
                      isActive ? "border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/20" : "border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
                    }`}>
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-gray-300 w-5">{idx + 1}</span>
                          <Link
                            href={`/agents/${encodeURIComponent(agentId)}`}
                            className="text-sm font-medium text-gray-900 dark:text-white hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                          >
                            {agentId}
                          </Link>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {step ? (
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${STEP_STYLE[step.status]}`}>
                              {step.status}
                            </span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500">
                              pending
                            </span>
                          )}
                          {step?.completedAt && (
                            <span className="text-xs text-gray-400">{dateTime(step.completedAt)}</span>
                          )}
                        </div>
                      </div>

                      {step?.input && (
                        <div className="mb-2">
                          <p className="text-[11px] font-mono text-gray-400 mb-1">INPUT</p>
                          <p className="text-xs text-gray-600 dark:text-gray-300 line-clamp-3 leading-relaxed">{step.input}</p>
                        </div>
                      )}

                      {step?.output && (
                        <div className="mb-2">
                          <p className="text-[11px] font-mono text-gray-400 mb-1">OUTPUT</p>
                          <p className="text-xs text-gray-700 dark:text-gray-300 line-clamp-4 leading-relaxed">{step.output}</p>
                        </div>
                      )}

                      {step?.error && (
                        <p className="text-xs text-red-600 dark:text-red-400 mt-1">{step.error}</p>
                      )}
                    </div>

                    {idx < workflow.agents.length - 1 && (
                      <StepConnector active={idx < workflow.currentStep} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Final output */}
          {workflow.finalOutput && (
            <div className="rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 p-5 mb-6">
              <p className="text-xs font-mono text-green-600 dark:text-green-400 mb-2">FINAL OUTPUT</p>
              <p className="text-sm text-gray-800 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">{workflow.finalOutput}</p>
            </div>
          )}

          {/* Reload */}
          {workflow.status === "running" && (
            <button
              onClick={() => void load(apiKey)}
              disabled={loading}
              className="text-sm px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 disabled:opacity-40 transition-colors"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          )}
        </>
      )}
    </>
  );
}
