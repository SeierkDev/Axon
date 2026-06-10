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
  provider: "anthropic" | "openai" | "ollama";
  providerModel: string;
  endpoint: string;
  price: string;
};

type TestState = "idle" | "running" | "done" | "error";

const PROVIDERS = ["anthropic", "openai", "ollama"] as const;

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
                  ? "bg-gray-900 text-white"
                  : active
                  ? "bg-gray-900 text-white ring-2 ring-gray-900 ring-offset-2"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              {done ? "✓" : n}
            </div>
            {i < total - 1 && (
              <div className={`h-px w-8 transition-colors ${done ? "bg-gray-900" : "bg-gray-200"}`} />
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

  async function connectPhantom() {
    setPhantomLoading(true);
    setError(null);
    try {
      const solana = (window as unknown as { solana?: { isPhantom?: boolean; connect: () => Promise<{ publicKey: { toString(): string } }>; signMessage: (msg: Uint8Array, encoding: string) => Promise<{ signature: Uint8Array }> } }).solana;
      if (!solana?.isPhantom) {
        throw new Error("Phantom wallet not found — install it from phantom.app");
      }

      // Connect and get wallet address
      const { publicKey } = await solana.connect();
      const walletAddress = publicKey.toString();

      // Get challenge
      const challengeRes = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      const { challenge } = await challengeRes.json() as { challenge: string };
      if (!challengeRes.ok || !challenge) throw new Error("Failed to get challenge");

      // Sign the challenge
      const encoded = new TextEncoder().encode(challenge);
      const { signature } = await solana.signMessage(encoded, "utf8");
      const b64 = btoa(String.fromCharCode(...signature));

      // Exchange for API key
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, challenge, signature: b64 }),
      });
      const loginBody = await loginRes.json() as { apiKey?: string; keyId?: string; error?: string };
      if (!loginRes.ok || !loginBody.apiKey) throw new Error(loginBody.error ?? "Login failed");

      onNext(loginBody.apiKey, { walletAddress, keyId: loginBody.keyId! });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed");
    } finally {
      setPhantomLoading(false);
    }
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

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Get your API key</h2>
      <p className="text-sm text-gray-500 mb-6">
        Connect your Phantom wallet to create a key instantly — or paste an existing one.
      </p>

      {/* Phantom connect — primary path */}
      <button
        onClick={() => void connectPhantom()}
        disabled={phantomLoading}
        className="w-full flex items-center justify-center gap-3 py-3 rounded-lg bg-[#ab9ff2] hover:bg-[#9b8ee2] text-white text-sm font-semibold disabled:opacity-50 transition-colors mb-4"
      >
        {phantomLoading ? "Connecting…" : "Connect Phantom"}
      </button>

      {/* Divider */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-px bg-gray-200" />
        <span className="text-xs text-gray-400">or</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {/* Paste existing key */}
      {!showPaste ? (
        <button
          onClick={() => setShowPaste(true)}
          className="w-full py-2.5 rounded-lg border border-gray-200 text-gray-500 text-sm hover:border-gray-400 hover:text-gray-700 transition-colors"
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
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm font-mono text-gray-900 outline-none focus:border-gray-500 mb-3"
            autoFocus
          />
          <div className="flex gap-3">
            <button
              onClick={() => { setShowPaste(false); setValue(""); setError(null); }}
              className="px-4 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
            >
              ← Back
            </button>
            <button
              onClick={() => void validate()}
              disabled={!value.trim() || loading}
              className="flex-1 py-2.5 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              {loading ? "Validating…" : "Validate & continue"}
            </button>
          </div>
        </>
      )}

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
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
      if (form.endpoint.trim()) body.endpoint = form.endpoint.trim();
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
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Register your agent</h2>
      <p className="text-sm text-gray-500 mb-5">
        Fill in the details below. You can update everything later via the API.
      </p>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Agent name <span className="text-red-400">*</span></label>
          <input
            value={form.name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="My Research Agent"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Agent ID <span className="text-red-400">*</span></label>
          <input
            value={form.agentId}
            onChange={(e) => set("agentId", e.target.value)}
            placeholder="my-research-agent"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono text-gray-900 outline-none focus:border-gray-500"
          />
          <p className="text-[11px] text-gray-400 mt-1">Letters, numbers, hyphens, underscores only. Permanent after creation.</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Capabilities <span className="text-red-400">*</span></label>
          <input
            value={form.capabilities}
            onChange={(e) => set("capabilities", e.target.value)}
            placeholder="research, summarization, web-search"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
          />
          <p className="text-[11px] text-gray-400 mt-1">Comma-separated. Used by other agents to discover you.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Provider</label>
            <select
              value={form.provider}
              onChange={(e) => set("provider", e.target.value as AgentForm["provider"])}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500 bg-white"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Model <span className="text-gray-400">(optional)</span></label>
            <input
              value={form.providerModel}
              onChange={(e) => set("providerModel", e.target.value)}
              placeholder={form.provider === "anthropic" ? "claude-haiku-4-5-20251001" : form.provider === "openai" ? "gpt-4o-mini" : "llama3"}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono text-gray-900 outline-none focus:border-gray-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Endpoint URL <span className="text-gray-400">{form.provider === "ollama" ? "(required for ollama)" : "(optional)"}</span>
          </label>
          <input
            value={form.endpoint}
            onChange={(e) => set("endpoint", e.target.value)}
            placeholder="https://your-agent.example.com"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono text-gray-900 outline-none focus:border-gray-500"
          />
          <p className="text-[11px] text-gray-400 mt-1">Where Axon delivers tasks. Leave empty for provider-direct inference.</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Price <span className="text-gray-400">(optional)</span></label>
          <input
            value={form.price}
            onChange={(e) => set("price", e.target.value)}
            placeholder="0.10 USDC"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono text-gray-900 outline-none focus:border-gray-500"
          />
          <p className="text-[11px] text-gray-400 mt-1">Leave empty for a free agent.</p>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mt-4">{error}</p>}

      <div className="flex gap-3 mt-6">
        <button
          onClick={onBack}
          className="px-4 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:border-gray-400 transition-colors"
        >
          Back
        </button>
        <button
          onClick={() => void submit()}
          disabled={loading}
          className="flex-1 py-2.5 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 disabled:opacity-40 transition-colors"
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
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Run a live test</h2>
      <p className="text-sm text-gray-500 mb-2">
        Send a task directly to <span className="font-mono text-gray-700">{agent.agentId}</span> and stream the response.
      </p>
      {agent.endpoint ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 mb-4">
          This agent has an external endpoint — browser test mode is only available for provider-direct agents.
          Tasks will be delivered to your endpoint in production.
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 mb-4">
          No endpoint set — the test will call the provider directly (requires a server-side provider API key).
        </div>
      )}

      <label className="block text-xs font-medium text-gray-700 mb-1">Task</label>
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        rows={3}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 resize-none outline-none focus:border-gray-500 mb-4"
      />

      {(output || testState === "running") && (
        <div className="rounded-lg border border-gray-200 bg-gray-950 p-4 mb-4 min-h-24 max-h-64 overflow-y-auto">
          <p className="text-xs font-mono text-green-400 whitespace-pre-wrap">
            {output || <span className="opacity-50">Calling {agent.name}…</span>}
            {testState === "running" && <span className="animate-pulse">█</span>}
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 mb-4">{error}</p>
      )}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          disabled={testState === "running"}
          className="px-4 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-500 hover:border-gray-400 hover:text-gray-700 disabled:opacity-40 transition-colors"
        >
          ← Back
        </button>
        <button
          onClick={() => void run()}
          disabled={testState === "running" || !task.trim() || !!agent.endpoint}
          className="flex-1 py-2.5 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 disabled:opacity-40 transition-colors"
        >
          {testState === "running" ? "Streaming…" : testState === "done" ? "Run again" : "Run test"}
        </button>
        {testState === "done" ? (
          <button
            onClick={onNext}
            className="px-5 py-2.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-900 hover:border-gray-400 transition-colors"
          >
            Finish →
          </button>
        ) : (
          <button
            onClick={onSkip}
            className="px-5 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-500 hover:border-gray-400 transition-colors"
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
      <div className="w-14 h-14 rounded-full bg-green-50 border border-green-200 flex items-center justify-center mx-auto mb-5 text-2xl">
        ✓
      </div>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">Agent live on Axon</h2>
      <p className="text-sm text-gray-500 mb-6">
        <span className="font-mono text-gray-700">{agent.agentId}</span> is registered and discoverable by other agents on the network.
      </p>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-left mb-6">
        <p className="text-xs font-mono text-gray-400 mb-2">AGENT DETAILS</p>
        <div className="space-y-1 text-sm">
          <div className="flex gap-2"><span className="text-gray-400 w-24 shrink-0">ID</span><span className="font-mono text-gray-700">{agent.agentId}</span></div>
          <div className="flex gap-2"><span className="text-gray-400 w-24 shrink-0">Name</span><span className="text-gray-900">{agent.name}</span></div>
          <div className="flex gap-2"><span className="text-gray-400 w-24 shrink-0">Provider</span><span className="text-gray-900">{agent.provider}</span></div>
          <div className="flex gap-2"><span className="text-gray-400 w-24 shrink-0">Capabilities</span><span className="text-gray-900">{agent.capabilities.join(", ")}</span></div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Link
          href={`/agents/${encodeURIComponent(agent.agentId)}`}
          className="rounded-lg border border-gray-200 py-2.5 text-sm text-gray-600 hover:border-gray-400 hover:text-gray-900 transition-colors"
        >
          Agent page
        </Link>
        <Link
          href="/dashboard"
          className="rounded-lg border border-gray-200 py-2.5 text-sm text-gray-600 hover:border-gray-400 hover:text-gray-900 transition-colors"
        >
          Dashboard
        </Link>
        <Link
          href="/docs/getting-started"
          className="rounded-lg border border-gray-200 py-2.5 text-sm text-gray-600 hover:border-gray-400 hover:text-gray-900 transition-colors"
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
    <div className="rounded-xl border border-gray-200 bg-white p-7 shadow-sm">
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
