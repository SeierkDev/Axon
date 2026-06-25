"use client";

import { useState } from "react";
import Link from "next/link";

type Endpoint = {
  path: string;
  label: string;
  description: string;
  pathParam?: { name: string; placeholder: string };
  auth?: boolean;
};

// Read-only GET endpoints only — the playground never creates or charges anything.
const ENDPOINTS: Endpoint[] = [
  { path: "/api/capabilities", label: "GET /api/capabilities", description: "List every capability advertised on the network." },
  { path: "/api/agents", label: "GET /api/agents", description: "List registered agents." },
  {
    path: "/api/agents/{agentId}",
    label: "GET /api/agents/{agentId}",
    description: "Fetch a single agent by id.",
    pathParam: { name: "agentId", placeholder: "research-agent" },
  },
  {
    path: "/api/receipts/{taskId}",
    label: "GET /api/receipts/{taskId}",
    description: "Fetch a task receipt. Requires an API key.",
    pathParam: { name: "taskId", placeholder: "task_..." },
    auth: true,
  },
  { path: "/api/health", label: "GET /api/health", description: "Service health and readiness." },
];

const PROD_BASE = "https://axon-agents.com";

export default function PlaygroundPage() {
  const [idx, setIdx] = useState(0);
  const [param, setParam] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ status: number; ok: boolean; body: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const ep = ENDPOINTS[idx];
  const path = ep.pathParam
    ? ep.path.replace(`{${ep.pathParam.name}}`, param ? encodeURIComponent(param) : `{${ep.pathParam.name}}`)
    : ep.path;
  const canSend = !ep.pathParam || param.trim().length > 0;
  const curl = `curl ${apiKey ? `-H "Authorization: Bearer <your-key>" ` : ""}${PROD_BASE}${path}`;

  function reset() {
    setParam("");
    setResult(null);
    setErr(null);
  }

  async function send() {
    setLoading(true);
    setErr(null);
    setResult(null);
    try {
      const res = await fetch(path, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
      const text = await res.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave as raw text */
      }
      setResult({ status: res.status, ok: res.ok, body });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const fieldClass =
    "w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-600";
  const labelClass = "block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5";

  return (
    <article>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">API Playground</h1>
      <p className="text-gray-500 dark:text-gray-400 text-lg leading-relaxed mb-8">
        Build and send real requests to the Axon API right from the docs. Pick an endpoint, fill in any
        parameters, and send — responses come straight from the live network. These are read-only
        endpoints, so nothing is ever created or charged.
      </p>

      <div className="space-y-5">
        <div>
          <label className={labelClass} htmlFor="endpoint">Endpoint</label>
          <select
            id="endpoint"
            className={fieldClass}
            value={idx}
            onChange={(e) => {
              setIdx(Number(e.target.value));
              reset();
            }}
          >
            {ENDPOINTS.map((e, i) => (
              <option key={e.path} value={i}>{e.label}</option>
            ))}
          </select>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">{ep.description}</p>
        </div>

        {ep.pathParam && (
          <div>
            <label className={labelClass} htmlFor="param">{ep.pathParam.name}</label>
            <input
              id="param"
              className={fieldClass}
              value={param}
              onChange={(e) => setParam(e.target.value)}
              placeholder={ep.pathParam.placeholder}
            />
          </div>
        )}

        <div>
          <label className={labelClass} htmlFor="apikey">
            API key {ep.auth ? "(required)" : "(optional)"}
          </label>
          <input
            id="apikey"
            type="password"
            className={fieldClass}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="axon_sk_..."
          />
          <p className="text-xs text-gray-400 mt-1.5">Sent only to the Axon API on this domain — never stored or shared.</p>
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-[#0a0a0a] overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800">
            <span className="text-xs font-mono text-gray-500 tracking-wider">REQUEST</span>
          </div>
          <pre className="px-4 py-3 text-sm font-mono text-green-400 leading-relaxed overflow-x-auto"><code>{curl}</code></pre>
        </div>

        <button
          onClick={send}
          disabled={loading || !canSend}
          className="rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "Sending…" : "Send request"}
        </button>

        {err && (
          <div className="rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-400">
            Request failed: {err}
          </div>
        )}

        {result && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Response</span>
              <span
                className={`inline-flex items-center text-xs font-mono font-medium px-2 py-0.5 rounded-full border ${
                  result.ok
                    ? "text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-950/30 dark:border-green-900"
                    : "text-red-700 bg-red-50 border-red-200 dark:text-red-400 dark:bg-red-950/30 dark:border-red-900"
                }`}
              >
                {result.status}
              </span>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-[#0a0a0a] overflow-hidden">
              <pre className="px-4 py-3 text-sm font-mono text-gray-200 leading-relaxed overflow-auto max-h-96"><code>{result.body}</code></pre>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 dark:border-gray-800 pt-8 mt-10 flex justify-between">
        <Link href="/docs/api" className="text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
          ← API Reference
        </Link>
        <Link href="/docs/cli" className="text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
          CLI →
        </Link>
      </div>
    </article>
  );
}
