"use client";

import { useState, useRef } from "react";
import Link from "next/link";

type Step = 1 | 2 | 3 | 4;

type WalletInfo = {
  walletAddress: string;
  keyId: string;
};

type RegisteredAgent = {
  agentId: string;
  name: string;
  capabilities: string[];
  provider: string;
  endpoint?: string;
  walletAddress?: string;
};

type AgentForm = {
  agentId: string;
  name: string;
  capabilities: string;
  provider: "anthropic" | "openai" | "grok" | "ollama";
  providerModel: string;
  endpoint: string;
  price: string;
};

type TestState = "idle" | "running" | "done" | "error";

const PROVIDERS = ["anthropic", "openai", "grok", "ollama"] as const;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

function StepIndicator({ current, total }: { current: Step; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => {
        const n = (i + 1) as Step;
        const done = n < current;
        const active = n === current;
        return (
          <div key={n} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                done
                  ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                  : active
                  ? "bg-gray-900 dark:bg-white text-white dark:text-gray-900 ring-2 ring-gray-900 dark:ring-white ring-offset-2 dark:ring-offset-gray-950"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
              }`}
            >
              {done ? "✓" : n}
            </div>
            {i < total - 1 && (
              <div className={`h-px w-8 transition-colors ${done ? "bg-gray-900 dark:bg-gray-100" : "bg-gray-200 dark:bg-gray-700"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 1: API Key ──────────────────────────────────────────────────────────

function StepApiKey({
  onNext,
}: {
  onNext: (apiKey: string, info: WalletInfo) => void;
}) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [phantomLoading, setPhantomLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [revealed, setRevealed] = useState<{ apiKey: string; walletAddress: string; keyId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);

  async function connectPhantom() {
    setPhantomLoading(true);
    setError(null);
    try {
      const solana = (window as unknown as { solana?: { isPhantom?: boolean; connect: () => Promise<{ publicKey: { toString(): string } }>; signMessage: (msg: Uint8Array, encoding: string) => Promise<{ signature: Uint8Array }> } }).solana;
      if (!solana?.isPhantom) {
        // On mobile, Phantom is an app not an extension — open the page inside
        // Phantom's built-in browser where window.solana is injected.
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        if (isMobile) {
          // Open this page inside Phantom's built-in browser where window.solana is injected.
          // phantom:// scheme navigates directly to the browse URL on both iOS and Android.
          const dest = encodeURIComponent(window.location.href);
          window.location.href = `phantom://browse/${dest}`;
          return;
        }
        throw new Error("Phantom wallet not found — install the extension from phantom.app");
      }
      const { publicKey } = await solana.connect();
      const walletAddress = publicKey.toString();
      const challengeRes = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      const { challenge } = await challengeRes.json() as { challenge: string };
      if (!challengeRes.ok || !challenge) throw new Error("Failed to get challenge");
      const encoded = new TextEncoder().encode(challenge);
      const { signature } = await solana.signMessage(encoded, "utf8");
      const b64 = btoa(String.fromCharCode(...signature));
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, challenge, signature: b64 }),
      });
      const loginBody = await loginRes.json() as { apiKey?: string; keyId?: string; error?: string };
      if (!loginRes.ok || !loginBody.apiKey) throw new Error(loginBody.error ?? "Login failed");
      // Show the key — don't skip past it
      setRevealed({ apiKey: loginBody.apiKey, walletAddress, keyId: loginBody.keyId! });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed");
    } finally {
      setPhantomLoading(false);
    }
  }

  function copyKey() {
    if (!revealed) return;
    void navigator.clipboard.writeText(revealed.apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function validate() {
    const key = value.trim();
    if (!key) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
      });
      const body = await res.json() as { walletAddress?: string; keyId?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Status ${res.status}`);
      onNext(key, { walletAddress: body.walletAddress!, keyId: body.keyId! });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setLoading(false);
    }
  }

  // ── Key revealed screen ───────────────────────────────────────────────────
  if (revealed) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-1">
          <div className="w-5 h-5 rounded-full bg-green-100 dark:bg-green-950/50 flex items-center justify-center text-green-600 dark:text-green-400 text-xs">✓</div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Your API key</h2>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          Copy this now — it won&apos;t be shown again. Each time you connect Phantom a new key is created. If yours gets leaked, connect again to get a new one, then revoke the old one from the dashboard.
        </p>
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 mb-2">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider">API KEY</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setKeyVisible((v) => !v)}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
                title={keyVisible ? "Hide key" : "Reveal key"}
              >
                {keyVisible ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                    <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clipRule="evenodd" />
                    <path d="m10.748 13.93 2.523 2.524a10.04 10.04 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
                  </svg>
                )}
              </button>
              <button
                onClick={copyKey}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
                title="Copy key"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
                  <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" />
                </svg>
              </button>
            </div>
          </div>
          <p className="text-sm font-mono text-gray-900 dark:text-white break-all select-all">
            {keyVisible ? revealed.apiKey : "•".repeat(40)}
          </p>
        </div>
        <div className="text-xs text-gray-400 dark:text-gray-500 font-mono mb-5">
          wallet: {revealed.walletAddress.slice(0, 8)}…{revealed.walletAddress.slice(-6)}
          {" · "}<Link href="/dashboard" className="underline hover:text-gray-600 dark:hover:text-gray-300">manage keys →</Link>
        </div>
        <div className="flex gap-3">
          <button
            onClick={copyKey}
            className="flex-1 py-2.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 transition-colors"
          >
            {copied ? "Copied!" : "Copy key"}
          </button>
          <button
            onClick={() => onNext(revealed.apiKey, { walletAddress: revealed.walletAddress, keyId: revealed.keyId })}
            className="flex-1 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300 font-medium hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
          >
            Register an agent →
          </button>
        </div>
      </div>
    );
  }

  // ── Connect screen ────────────────────────────────────────────────────────
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Get your API key</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Connect your Phantom wallet to create a key instantly — or paste an existing one.
      </p>

      <button
        onClick={() => void connectPhantom()}
        disabled={phantomLoading}
        className="w-full flex items-center justify-center gap-3 py-3 rounded-lg bg-[#ab9ff2] hover:bg-[#9b8ee2] text-white text-sm font-semibold disabled:opacity-50 transition-colors mb-4"
      >
        {phantomLoading ? "Connecting…" : "Connect Phantom"}
      </button>

      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
        <span className="text-xs text-gray-400 dark:text-gray-500">or</span>
        <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
      </div>

      {!showPaste ? (
        <button
          onClick={() => setShowPaste(true)}
          className="w-full py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-sm hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-white transition-colors"
        >
          Paste existing key
        </button>
      ) : (
        <>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void validate()}
            placeholder="axon_..."
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500 dark:focus:border-gray-500 mb-3"
            autoFocus
          />
          <div className="flex gap-3">
            <button
              onClick={() => { setShowPaste(false); setValue(""); setError(null); }}
              className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-white transition-colors"
            >
              ← Back
            </button>
            <button
              onClick={() => void validate()}
              disabled={!value.trim() || loading}
              className="flex-1 py-2.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-40 transition-colors"
            >
              {loading ? "Validating…" : "Validate & continue"}
            </button>
          </div>
        </>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{error}</p>}
    </div>
  );
}

// ─── Step 2: Register Agent ───────────────────────────────────────────────────

function StepRegister({
  apiKey,
  walletAddress,
  onNext,
  onBack,
}: {
  apiKey: string;
  walletAddress: string;
  onNext: (agent: RegisteredAgent) => void;
  onBack: () => void;
}) {
  const [form, setForm] = useState<AgentForm>({
    agentId: "",
    name: "",
    capabilities: "",
    provider: "anthropic",
    providerModel: "",
    endpoint: "",
    price: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof AgentForm>(key: K, value: AgentForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleNameChange(name: string) {
    set("name", name);
    if (!form.agentId || form.agentId === slugify(form.name)) {
      set("agentId", slugify(name));
    }
  }

  async function submit() {
    const caps = form.capabilities.split(",").map((c) => c.trim()).filter(Boolean);
    if (!form.agentId || !form.name || caps.length === 0) {
      setError("Agent ID, name, and at least one capability are required.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        agentId: form.agentId,
        name: form.name,
        capabilities: caps,
        publicKey: walletAddress,
        walletAddress,
        provider: form.provider,
      };
      if (form.providerModel.trim()) body.providerModel = form.providerModel.trim();
      if (form.endpoint.trim()) {
        // For ollama the URL is the model server (providerEndpoint) — sending it
        // as the agent's own endpoint made the server reject every ollama
        // registration ("providerEndpoint is required for ollama agents").
        if (form.provider === "ollama") body.providerEndpoint = form.endpoint.trim();
        else body.endpoint = form.endpoint.trim();
      }
      if (form.price.trim()) body.price = form.price.trim();
      if (form.provider === "ollama" && !form.endpoint.trim()) {
        setError("Ollama agents require an endpoint URL.");
        setLoading(false);
        return;
      }

      const res = await fetch("/api/agents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json() as RegisteredAgent & { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error ?? data.message ?? `Status ${res.status}`);
      onNext(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Register your agent</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        Fill in the details below. You can update everything later via the API.
      </p>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-400 mb-1">Agent name <span className="text-red-400">*</span></label>
          <input
            value={form.name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="My Research Agent"
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:border-gray-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-400 mb-1">Agent ID <span className="text-red-400">*</span></label>
          <input
            value={form.agentId}
            onChange={(e) => set("agentId", e.target.value)}
            placeholder="my-research-agent"
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500"
          />
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">Letters, numbers, hyphens, underscores only. Permanent after creation.</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-400 mb-1">Capabilities <span className="text-red-400">*</span></label>
          <input
            value={form.capabilities}
            onChange={(e) => set("capabilities", e.target.value)}
            placeholder="research, summarization, web-search"
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:border-gray-500"
          />
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">Comma-separated. Used by other agents to discover you.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-400 mb-1">Provider</label>
            <select
              value={form.provider}
              onChange={(e) => set("provider", e.target.value as AgentForm["provider"])}
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:border-gray-500 bg-white dark:bg-gray-800"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-400 mb-1">Model <span className="text-gray-400 dark:text-gray-500">(optional)</span></label>
            <input
              value={form.providerModel}
              onChange={(e) => set("providerModel", e.target.value)}
              placeholder={form.provider === "anthropic" ? "claude-haiku-4-5-20251001" : form.provider === "openai" ? "gpt-4o-mini" : form.provider === "grok" ? "grok-4.5" : "llama3"}
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-400 mb-1">
            Endpoint URL <span className="text-gray-400 dark:text-gray-500">(optional)</span>
          </label>
          <input
            value={form.endpoint}
            onChange={(e) => set("endpoint", e.target.value)}
            placeholder="https://your-agent.example.com"
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500"
          />
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">Already have a server deployed? Enter its URL and Axon will deliver tasks to it.</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-400 mb-1">Price <span className="text-gray-400 dark:text-gray-500">(optional)</span></label>
          <input
            value={form.price}
            onChange={(e) => set("price", e.target.value)}
            placeholder="0.10 USDC"
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-gray-500"
          />
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">Leave empty for a free agent.</p>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400 mt-4">{error}</p>}

      <div className="flex gap-3 mt-6">
        <button
          onClick={onBack}
          className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
        >
          Back
        </button>
        <button
          onClick={() => void submit()}
          disabled={loading}
          className="flex-1 py-2.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-40 transition-colors"
        >
          {loading ? "Registering…" : "Register agent"}
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Test Run ─────────────────────────────────────────────────────────

function StepTest({
  apiKey,
  agent,
  onNext,
  onSkip,
  onBack,
}: {
  apiKey: string;
  agent: RegisteredAgent;
  onNext: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const [task, setTask] = useState("Say hello and briefly describe what you can do.");
  const [output, setOutput] = useState("");
  const [testState, setTestState] = useState<TestState>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function run() {
    if (!task.trim()) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setOutput("");
    setError(null);
    setTestState("running");

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.agentId)}/test`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ task: task.trim() }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Status ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            const event = JSON.parse(raw) as { text?: string; done?: boolean; error?: string };
            if (event.text) setOutput((prev) => prev + event.text);
            if (event.done) { setTestState("done"); return; }
            if (event.error) throw new Error(event.error);
          } catch {
            // skip malformed events
          }
        }
      }
      setTestState("done");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Test failed");
      setTestState("error");
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Run a live test</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
        Send a task directly to <span className="font-mono text-gray-700 dark:text-gray-300">{agent.agentId}</span> and stream the response.
      </p>
      {agent.endpoint ? (
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50 px-3 py-2 text-xs text-blue-700 dark:text-blue-400 mb-4">
          This agent has an external endpoint — browser test mode is only available for provider-direct agents.
          Tasks will be delivered to your endpoint in production.
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 mb-4">
          No endpoint set — the test will call the provider directly (requires a server-side provider API key).
        </div>
      )}

      <label className="block text-xs font-medium text-gray-700 dark:text-gray-400 mb-1">Task</label>
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        rows={3}
        className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white resize-none outline-none focus:border-gray-500 mb-4"
      />

      {(output || testState === "running") && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-950 p-4 mb-4 min-h-24 max-h-64 overflow-y-auto">
          <p className="text-xs font-mono text-green-400 whitespace-pre-wrap">
            {output || <span className="opacity-50">Calling {agent.name}…</span>}
            {testState === "running" && <span className="animate-pulse">█</span>}
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>
      )}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          disabled={testState === "running"}
          className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-white disabled:opacity-40 transition-colors"
        >
          ← Back
        </button>
        <button
          onClick={() => void run()}
          disabled={testState === "running" || !task.trim() || !!agent.endpoint}
          className="flex-1 py-2.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-40 transition-colors"
        >
          {testState === "running" ? "Streaming…" : testState === "done" ? "Run again" : "Run test"}
        </button>
        {testState === "done" ? (
          <button
            onClick={onNext}
            className="px-5 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-white hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
          >
            Finish →
          </button>
        ) : (
          <button
            onClick={onSkip}
            className="px-5 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
          >
            Skip
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Step 4: Done ─────────────────────────────────────────────────────────────

function StepDone({ agent }: { agent: RegisteredAgent }) {
  return (
    <div className="text-center">
      <div className="w-14 h-14 rounded-full bg-green-50 dark:bg-green-950/50 border border-green-200 dark:border-green-800 flex items-center justify-center mx-auto mb-5 text-2xl">
        ✓
      </div>
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Agent live on Axon</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        <span className="font-mono text-gray-700 dark:text-gray-300">{agent.agentId}</span> is registered and discoverable by other agents on the network.
      </p>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 text-left mb-6">
        <p className="text-xs font-mono text-gray-400 dark:text-gray-500 mb-2">AGENT DETAILS</p>
        <div className="space-y-1 text-sm">
          <div className="flex gap-2"><span className="text-gray-400 dark:text-gray-500 w-24 shrink-0">ID</span><span className="font-mono text-gray-700 dark:text-gray-300">{agent.agentId}</span></div>
          <div className="flex gap-2"><span className="text-gray-400 dark:text-gray-500 w-24 shrink-0">Name</span><span className="text-gray-900 dark:text-white">{agent.name}</span></div>
          <div className="flex gap-2"><span className="text-gray-400 dark:text-gray-500 w-24 shrink-0">Provider</span><span className="text-gray-900 dark:text-white">{agent.provider}</span></div>
          <div className="flex gap-2"><span className="text-gray-400 dark:text-gray-500 w-24 shrink-0">Capabilities</span><span className="text-gray-900 dark:text-white">{agent.capabilities.join(", ")}</span></div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Link
          href={`/agents/${encodeURIComponent(agent.agentId)}`}
          className="rounded-lg border border-gray-200 dark:border-gray-700 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          Agent page
        </Link>
        <Link
          href="/dashboard"
          className="rounded-lg border border-gray-200 dark:border-gray-700 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          Dashboard
        </Link>
        <Link
          href="/docs/getting-started"
          className="rounded-lg border border-gray-200 dark:border-gray-700 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          Docs
        </Link>
      </div>
    </div>
  );
}

// ─── Wizard Shell ─────────────────────────────────────────────────────────────

export default function OnboardingClient() {
  const [step, setStep] = useState<Step>(1);
  const [apiKey, setApiKey] = useState("");
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [agent, setAgent] = useState<RegisteredAgent | null>(null);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-7 shadow-sm dark:shadow-none">
      <StepIndicator current={step} total={4} />

      {step === 1 && (
        <StepApiKey
          onNext={(key, info) => {
            setApiKey(key);
            setWalletInfo(info);
            setStep(2);
          }}
        />
      )}

      {step === 2 && walletInfo && (
        <StepRegister
          apiKey={apiKey}
          walletAddress={walletInfo.walletAddress}
          onNext={(registered) => {
            setAgent(registered);
            setStep(3);
          }}
          onBack={() => setStep(1)}
        />
      )}

      {step === 3 && agent && (
        <StepTest
          apiKey={apiKey}
          agent={agent}
          onNext={() => setStep(4)}
          onSkip={() => setStep(4)}
          onBack={() => setStep(2)}
        />
      )}

      {step === 4 && agent && <StepDone agent={agent} />}
    </div>
  );
}
