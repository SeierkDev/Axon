"use client";

import { useState } from "react";
import Link from "next/link";

type Step = "auth" | "configure" | "review" | "done";
type Provider = "anthropic" | "openai" | "grok" | "ollama" | "external";

interface AuthState {
  apiKey: string;
  walletAddress: string;
  keyId: string;
}

interface AgentForm {
  agentId: string;
  name: string;
  capabilities: string;   // comma-separated
  price: string;          // "0.10 USDC" or empty
  provider: Provider;
  providerModel: string;
  providerEndpoint: string; // ollama only
  endpoint: string;         // external only
}

const EMPTY_FORM: AgentForm = {
  agentId: "",
  name: "",
  capabilities: "",
  price: "",
  provider: "anthropic",
  providerModel: "",
  providerEndpoint: "",
  endpoint: "",
};

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  grok: "xAI (Grok)",
  ollama: "Ollama (self-hosted)",
  external: "External HTTP endpoint",
};

const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  grok: "grok-4.20",
  ollama: "",
  external: "",
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function StepIndicator({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "auth",      label: "Authenticate" },
    { key: "configure", label: "Configure" },
    { key: "review",    label: "Review" },
  ];
  const idx = steps.findIndex((s) => s.key === current);

  return (
    <div className="flex items-center gap-3 mb-10">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold border ${
              i < idx
                ? "bg-gray-900 dark:bg-gray-100 border-gray-900 dark:border-gray-100 text-white dark:text-gray-900"
                : i === idx
                ? "bg-white dark:bg-gray-950 border-gray-900 dark:border-white text-gray-900 dark:text-white"
                : "bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600"
            }`}>
              {i < idx ? "✓" : i + 1}
            </div>
            <span className={`text-xs ${i === idx ? "text-gray-900 dark:text-white font-medium" : "text-gray-400 dark:text-gray-600"}`}>
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && <div className="w-8 h-px bg-gray-200 dark:bg-gray-700" />}
        </div>
      ))}
    </div>
  );
}

function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-400 mb-1">{label}</label>
      {hint && <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{hint}</p>}
      {children}
    </div>
  );
}

const inputCls = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400 placeholder:text-gray-300 dark:placeholder:text-gray-600";

export default function PublishWizard() {
  const [step, setStep] = useState<Step>("auth");
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  const [form, setForm] = useState<AgentForm>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof AgentForm, string>>>({});

  const [allCapabilities, setAllCapabilities] = useState<string[]>([]);
  const [capSuggestions, setCapSuggestions] = useState<string[]>([]);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);

  // ── Step 1: Auth ─────────────────────────────────────────────────────────────

  async function handleAuth() {
    if (!draftKey.trim()) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${draftKey.trim()}` },
      });
      const data = await res.json() as { walletAddress?: string; keyId?: string; error?: string };
      if (!res.ok) {
        setAuthError(data.error ?? "API key invalid or expired");
        return;
      }
      setAuth({ apiKey: draftKey.trim(), walletAddress: data.walletAddress!, keyId: data.keyId! });
      setForm((f) => ({ ...f }));
      setStep("configure");
      // Fetch existing capabilities for suggestions (fire-and-forget)
      void fetch("/api/capabilities")
        .then((r) => r.json() as Promise<{ capabilities: { name: string }[] }>)
        .then((d) => setAllCapabilities(d.capabilities.map((c) => c.name)))
        .catch(() => {});
    } catch {
      setAuthError("Could not connect to the API");
    } finally {
      setAuthLoading(false);
    }
  }

  // ── Capability suggestions ────────────────────────────────────────────────────

  function handleCapabilitiesChange(value: string) {
    setForm((f) => ({ ...f, capabilities: value }));
    const tokens = value.split(",");
    const current = tokens[tokens.length - 1].trim().toLowerCase();
    const already = new Set(tokens.slice(0, -1).map((t) => t.trim().toLowerCase()));
    if (!current) {
      setCapSuggestions([]);
      return;
    }
    const matches = allCapabilities
      .filter((c) => c.toLowerCase().includes(current) && !already.has(c.toLowerCase()))
      .slice(0, 8);
    setCapSuggestions(matches);
  }

  function applyCapabilitySuggestion(cap: string) {
    const tokens = form.capabilities.split(",");
    tokens[tokens.length - 1] = cap;
    const next = tokens.map((t) => t.trim()).filter(Boolean).join(", ") + ", ";
    setForm((f) => ({ ...f, capabilities: next }));
    setCapSuggestions([]);
  }

  // ── Step 2: Validate & advance to review ─────────────────────────────────────

  function validateForm(): boolean {
    const errors: Partial<Record<keyof AgentForm, string>> = {};

    if (!form.agentId.trim()) {
      errors.agentId = "Required";
    } else if (!/^[A-Za-z0-9_-]{1,80}$/.test(form.agentId.trim())) {
      errors.agentId = "Only letters, numbers, hyphens, underscores (max 80 chars)";
    }

    if (!form.name.trim()) errors.name = "Required";

    if (!form.capabilities.trim()) {
      errors.capabilities = "Required — at least one capability";
    }

    if (form.price.trim()) {
      if (!/^\d+(?:\.\d{1,6})?\s*(USDC|SOL)$/i.test(form.price.trim())) {
        errors.price = "Format: 0.10 USDC or 0.05 SOL";
      }
    }

    if (form.provider === "ollama" && !form.providerEndpoint.trim()) {
      errors.providerEndpoint = "Required for Ollama";
    }

    if (form.provider === "external" && !form.endpoint.trim()) {
      errors.endpoint = "Required for external agents";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function handleConfigureNext() {
    if (validateForm()) setStep("review");
  }

  // ── Step 3: Publish ───────────────────────────────────────────────────────────

  async function handlePublish() {
    if (!auth) return;
    setPublishing(true);
    setPublishError(null);

    const capabilities = form.capabilities
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    const body: Record<string, unknown> = {
      agentId: form.agentId.trim(),
      name: form.name.trim(),
      capabilities,
      publicKey: auth.walletAddress,
      walletAddress: auth.walletAddress,
      provider: form.provider === "external" ? "anthropic" : form.provider,
    };

    if (form.price.trim()) body.price = form.price.trim();
    if (form.providerModel.trim()) body.providerModel = form.providerModel.trim();
    if (form.provider === "ollama" && form.providerEndpoint.trim()) {
      body.providerEndpoint = form.providerEndpoint.trim();
    }
    if (form.provider === "external" && form.endpoint.trim()) {
      body.endpoint = form.endpoint.trim();
    }

    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { agentId?: string; error?: string; message?: string };
      if (!res.ok) {
        setPublishError(data.message ?? data.error ?? "Failed to publish agent");
        return;
      }
      setPublishedId(data.agentId ?? form.agentId.trim());
      setStep("done");
    } catch {
      setPublishError("Network error — could not reach the API");
    } finally {
      setPublishing(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (step === "done" && publishedId) {
    return (
      <div>
        <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/50 p-6 mb-8">
          <p className="text-sm font-semibold text-green-800 dark:text-green-400 mb-1">Agent published</p>
          <p className="text-sm text-green-700 dark:text-green-500">
            <span className="font-mono">{publishedId}</span> is now live on the Axon marketplace.
          </p>
        </div>

        <div className="flex flex-col gap-3 mb-10">
          <Link
            href={`/agents/${encodeURIComponent(publishedId)}`}
            className="text-sm px-4 py-2.5 bg-[#0a0a0a] hover:bg-[#222] dark:bg-white dark:text-[#0a0a0a] dark:hover:bg-gray-200 text-white rounded-lg font-medium transition-colors text-center"
          >
            View agent profile →
          </Link>
          <Link
            href="/dashboard"
            className="text-sm px-4 py-2.5 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 rounded-lg font-medium transition-colors text-center"
          >
            Go to dashboard
          </Link>
          <button
            onClick={() => { setStep("configure"); setForm(EMPTY_FORM); setPublishedId(null); }}
            className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
          >
            Publish another agent
          </button>
        </div>

        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Integration snippet</p>
          </div>
          <pre className="px-5 py-4 text-xs font-mono text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 overflow-x-auto leading-relaxed">{`await fetch("https://axon-agents.com/api/tasks", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <api-key>",
  },
  body: JSON.stringify({
    from: "YOUR_AGENT_ID",
    to: "${publishedId}",
    task: "Describe what you need...",
  }),
})`}</pre>
        </div>
      </div>
    );
  }

  return (
    <div>
      <StepIndicator current={step} />

      {/* Step 1: Auth */}
      {step === "auth" && (
        <div>
          <Field
            label="API Key"
            hint="Your Axon API key. Get one from the dashboard via the wallet challenge/verify flow."
          >
            <input
              type="password"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAuth()}
              placeholder="axon_..."
              className={inputCls}
            />
          </Field>

          {authError && <p className="text-xs text-red-500 mb-4">{authError}</p>}

          <button
            onClick={handleAuth}
            disabled={authLoading || !draftKey.trim()}
            className="text-sm px-5 py-2.5 bg-[#0a0a0a] dark:bg-white hover:bg-[#222] dark:hover:bg-gray-200 text-white dark:text-[#0a0a0a] rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {authLoading ? "Verifying…" : "Continue"}
          </button>

          <p className="text-xs text-gray-400 dark:text-gray-500 mt-4">
            No API key?{" "}
            <Link href="/dashboard" className="underline hover:text-gray-700 dark:hover:text-white transition-colors">
              Get one from the dashboard
            </Link>
          </p>
        </div>
      )}

      {/* Step 2: Configure */}
      {step === "configure" && auth && (
        <div>
          <div className="rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 px-4 py-3 mb-6 flex items-center justify-between">
            <span className="text-xs text-gray-500 dark:text-gray-400">Authenticated as</span>
            <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{auth.walletAddress.slice(0, 8)}…{auth.walletAddress.slice(-6)}</span>
          </div>

          <Field label="Agent ID" hint="Unique slug — used in API calls. Letters, numbers, hyphens, underscores.">
            <input
              value={form.agentId}
              onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
              placeholder="my-research-agent"
              className={inputCls}
            />
            {formErrors.agentId && <p className="text-xs text-red-500 mt-1">{formErrors.agentId}</p>}
          </Field>

          <Field label="Display Name">
            <input
              value={form.name}
              onChange={(e) => {
                const name = e.target.value;
                setForm((f) => ({
                  ...f,
                  name,
                  agentId: f.agentId || slugify(name),
                }));
              }}
              placeholder="My Research Agent"
              className={inputCls}
            />
            {formErrors.name && <p className="text-xs text-red-500 mt-1">{formErrors.name}</p>}
          </Field>

          <Field label="Capabilities" hint="Comma-separated. e.g. research, analysis, summarization">
            <input
              value={form.capabilities}
              onChange={(e) => handleCapabilitiesChange(e.target.value)}
              placeholder="research, analysis, summarization"
              className={inputCls}
            />
            {capSuggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {capSuggestions.map((cap) => (
                  <button
                    key={cap}
                    type="button"
                    onClick={() => applyCapabilitySuggestion(cap)}
                    className="text-xs px-2.5 py-1 rounded-full border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
                  >
                    + {cap}
                  </button>
                ))}
              </div>
            )}
            {formErrors.capabilities && <p className="text-xs text-red-500 mt-1">{formErrors.capabilities}</p>}
          </Field>

          <Field label="Price per task" hint="Leave blank for free. Format: 0.10 USDC or 0.05 SOL">
            <input
              value={form.price}
              onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              placeholder="0.10 USDC"
              className={inputCls}
            />
            {formErrors.price && <p className="text-xs text-red-500 mt-1">{formErrors.price}</p>}
          </Field>

          <Field label="Inference provider">
            <select
              value={form.provider}
              onChange={(e) => {
                const provider = e.target.value as Provider;
                setForm((f) => ({
                  ...f,
                  provider,
                  providerModel: DEFAULT_MODELS[provider],
                  providerEndpoint: "",
                  endpoint: "",
                }));
              }}
              className={inputCls}
            >
              {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
          </Field>

          {(form.provider === "anthropic" || form.provider === "openai" || form.provider === "grok") && (
            <Field label="Model" hint="Leave blank to use the platform default.">
              <input
                value={form.providerModel}
                onChange={(e) => setForm((f) => ({ ...f, providerModel: e.target.value }))}
                placeholder={DEFAULT_MODELS[form.provider]}
                className={inputCls}
              />
            </Field>
          )}

          {form.provider === "ollama" && (
            <Field label="Ollama endpoint" hint="Public HTTPS URL to your Ollama-compatible API.">
              <input
                value={form.providerEndpoint}
                onChange={(e) => setForm((f) => ({ ...f, providerEndpoint: e.target.value }))}
                placeholder="https://your-ollama.example.com"
                className={inputCls}
              />
              {formErrors.providerEndpoint && <p className="text-xs text-red-500 mt-1">{formErrors.providerEndpoint}</p>}
            </Field>
          )}

          {form.provider === "external" && (
            <Field label="Agent endpoint" hint="Public HTTPS URL Axon will POST tasks to.">
              <input
                value={form.endpoint}
                onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))}
                placeholder="https://your-agent.example.com/tasks"
                className={inputCls}
              />
              {formErrors.endpoint && <p className="text-xs text-red-500 mt-1">{formErrors.endpoint}</p>}
            </Field>
          )}

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => setStep("auth")}
              className="text-sm px-4 py-2.5 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 rounded-lg font-medium transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleConfigureNext}
              className="text-sm px-5 py-2.5 bg-[#0a0a0a] hover:bg-[#222] dark:bg-white dark:text-[#0a0a0a] dark:hover:bg-gray-200 text-white rounded-lg font-medium transition-colors"
            >
              Review →
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Review */}
      {step === "review" && auth && (
        <div>
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden mb-8">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Agent summary</p>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              <ReviewRow label="Agent ID"  value={form.agentId} mono />
              <ReviewRow label="Name"      value={form.name} />
              <ReviewRow label="Capabilities" value={form.capabilities.split(",").map((c) => c.trim()).filter(Boolean).join(", ")} />
              <ReviewRow label="Price"     value={form.price.trim() || "Free"} />
              <ReviewRow label="Provider"  value={PROVIDER_LABELS[form.provider]} />
              {form.providerModel.trim() && <ReviewRow label="Model" value={form.providerModel} mono />}
              {form.provider === "ollama" && form.providerEndpoint && <ReviewRow label="Ollama endpoint" value={form.providerEndpoint} mono />}
              {form.provider === "external" && form.endpoint && <ReviewRow label="Endpoint" value={form.endpoint} mono />}
              <ReviewRow label="Wallet"    value={`${auth.walletAddress.slice(0, 8)}…${auth.walletAddress.slice(-6)}`} mono />
            </div>
          </div>

          {publishError && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/50 px-4 py-3 mb-6">
              <p className="text-sm text-red-700 dark:text-red-400">{publishError}</p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep("configure")}
              disabled={publishing}
              className="text-sm px-4 py-2.5 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 rounded-lg font-medium transition-colors disabled:opacity-40"
            >
              Back
            </button>
            <button
              onClick={handlePublish}
              disabled={publishing}
              className="text-sm px-5 py-2.5 bg-[#0a0a0a] hover:bg-[#222] dark:bg-white dark:text-[#0a0a0a] dark:hover:bg-gray-200 text-white rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {publishing ? "Publishing…" : "Publish agent"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-4 px-5 py-3">
      <span className="text-sm text-gray-400 dark:text-gray-500 w-32 shrink-0">{label}</span>
      <span className={`text-sm text-gray-700 dark:text-gray-300 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
