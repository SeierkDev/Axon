"use client";

import { useState } from "react";
import Link from "next/link";

interface Template {
  templateId: string;
  name: string;
  agents: string[];
  taskTemplate: string;
  parameters: string[];
}

const field =
  "w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-600";
const label = "block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5";

export default function WorkflowTemplatesClient() {
  const [apiKey, setApiKey] = useState("");
  const [from, setFrom] = useState("");
  const [name, setName] = useState("");
  const [agents, setAgents] = useState<string[]>(["", ""]);
  const [taskTemplate, setTaskTemplate] = useState("Write a blog post about {{topic}} for {{audience}}");
  const [template, setTemplate] = useState<Template | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function updateAgent(i: number, v: string) {
    setAgents((prev) => prev.map((a, idx) => (idx === i ? v : a)));
  }
  function addAgent() {
    if (agents.length < 20) setAgents((p) => [...p, ""]);
  }
  function removeAgent(i: number) {
    if (agents.length > 1) setAgents((p) => p.filter((_, idx) => idx !== i));
  }

  async function createTemplate() {
    setError(null);
    setTemplate(null);
    setWorkflowId(null);
    const chain = agents.map((a) => a.trim()).filter(Boolean);
    if (!name.trim() || chain.length < 1) {
      setError("A template needs a name and at least one agent.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/workflow-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
        body: JSON.stringify({ from: from.trim(), name: name.trim(), agents: chain, taskTemplate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTemplate(data as Template);
      setParams(Object.fromEntries(((data.parameters ?? []) as string[]).map((p) => [p, ""])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function instantiate() {
    if (!template) return;
    setError(null);
    setWorkflowId(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/workflow-templates/${encodeURIComponent(template.templateId)}/instantiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
        body: JSON.stringify({ from: from.trim(), params }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setWorkflowId(data.workflow?.workflowId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link
        href="/docs/concepts/workflow-templates"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white mb-6 transition-colors"
      >
        ← Workflow templates docs
      </Link>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Create a workflow template</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8">
        Define a reusable agent chain with a parameterized task, then instantiate it with values to run a
        real workflow. Use <code className="font-mono">{"{{name}}"}</code> in the task for parameters.
      </p>

      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={label} htmlFor="key">API key</label>
            <input id="key" type="password" className={field} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="axon_sk_..." />
          </div>
          <div>
            <label className={label} htmlFor="from">Owner (your agent id / wallet)</label>
            <input id="from" className={field} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="my-agent" />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="name">Template name</label>
          <input id="name" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="blog-pipeline" />
        </div>

        <div>
          <span className={label}>Agent chain (in order)</span>
          <div className="space-y-2">
            {agents.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs font-mono text-gray-400 w-5 shrink-0">{i + 1}</span>
                <input className={field} value={a} onChange={(e) => updateAgent(i, e.target.value)} placeholder="agent id" />
                <button
                  onClick={() => removeAgent(i)}
                  disabled={agents.length <= 1}
                  className="shrink-0 w-9 h-9 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="Remove agent"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {agents.length < 20 && (
            <button onClick={addAgent} className="mt-2 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors">
              + Add agent
            </button>
          )}
        </div>

        <div>
          <label className={label} htmlFor="task">Task template</label>
          <textarea id="task" rows={3} className={field} value={taskTemplate} onChange={(e) => setTaskTemplate(e.target.value)} />
        </div>

        <button
          onClick={createTemplate}
          disabled={busy || !apiKey || !from || !name}
          className="rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "Working…" : "Create template"}
        </button>
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {template && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Template saved</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            <span className="font-medium">{template.name}</span> · chain: {template.agents.join(" → ")}
          </p>

          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Instantiate</h3>
          {template.parameters.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">This template has no parameters.</p>
          ) : (
            <div className="space-y-3 mb-3">
              {template.parameters.map((p) => (
                <div key={p}>
                  <label className={label}>{p}</label>
                  <input
                    className={field}
                    value={params[p] ?? ""}
                    onChange={(e) => setParams((prev) => ({ ...prev, [p]: e.target.value }))}
                    placeholder={`value for ${p}`}
                  />
                </div>
              ))}
            </div>
          )}
          <button
            onClick={instantiate}
            disabled={busy}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
          >
            {busy ? "Running…" : "Run workflow"}
          </button>

          {workflowId && (
            <div className="mt-5 rounded-lg border border-green-300 dark:border-green-900 bg-green-50 dark:bg-green-950/30 px-4 py-3 text-sm text-green-800 dark:text-green-300">
              Workflow started: <code className="font-mono">{workflowId}</code> — running the chain now.
            </div>
          )}
        </section>
      )}
    </main>
  );
}
