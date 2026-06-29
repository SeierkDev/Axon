"use client";

import { useState } from "react";
import Link from "next/link";

interface Attestation {
  attestationId: string;
  capability: string;
  verifier: string;
  createdAt: string;
}

interface PhantomProvider {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signMessage(message: Uint8Array, encoding: string): Promise<{ signature: Uint8Array }>;
}

function getPhantom(): PhantomProvider | null {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const provider = w.phantom?.solana ?? w.solana;
  return provider && provider.isPhantom ? provider : null;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const field =
  "w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-600";
const labelCls = "block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5";

export default function AttestationsClient() {
  const [agentId, setAgentId] = useState("");
  const [capability, setCapability] = useState("");
  const [attestations, setAttestations] = useState<Attestation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadAttestations(id: string) {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/attestations`);
      const data = await res.json();
      setAttestations(data.attestations ?? []);
    } catch {
      /* ignore */
    }
  }

  async function attest() {
    setError(null);
    setDone(null);
    const id = agentId.trim();
    const cap = capability.trim();
    if (!id || !cap) {
      setError("Enter an agent ID and a capability.");
      return;
    }
    const phantom = getPhantom();
    if (!phantom) {
      setError("Phantom wallet not found — install it to sign attestations.");
      return;
    }
    setBusy(true);
    try {
      const { publicKey } = await phantom.connect();
      const verifier = publicKey.toString();
      const message = `axon-attest:${id}:${cap}`;
      const { signature } = await phantom.signMessage(new TextEncoder().encode(message), "utf8");
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/attestations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: cap, verifier, signature: toBase64(signature) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDone(`Attested "${cap}" for ${id} as ${verifier.slice(0, 8)}…`);
      await loadAttestations(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link
        href="/docs/concepts/capability-attestations"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white mb-6 transition-colors"
      >
        ← Capability attestations docs
      </Link>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Attest a capability</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8">
        Vouch that an agent really has a capability it lists. You sign a message with your Phantom wallet —
        no Axon account needed. The agent must list the capability, and you can&apos;t attest your own agent.
      </p>

      <div className="space-y-4">
        <div>
          <label className={labelCls} htmlFor="agent">Agent ID</label>
          <input id="agent" className={field} value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="scholar-synth" />
        </div>
        <div>
          <label className={labelCls} htmlFor="cap">Capability</label>
          <input id="cap" className={field} value={capability} onChange={(e) => setCapability(e.target.value)} placeholder="research" />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={attest}
            disabled={busy || !agentId || !capability}
            className="rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? "Signing…" : "Attest with Phantom"}
          </button>
          <button
            onClick={() => loadAttestations(agentId.trim())}
            disabled={!agentId}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
          >
            View attestations
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}
      {done && (
        <div className="mt-5 rounded-lg border border-green-300 dark:border-green-900 bg-green-50 dark:bg-green-950/30 px-4 py-3 text-sm text-green-800 dark:text-green-300">
          {done}
        </div>
      )}

      {attestations.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Attestations</h2>
          <div className="space-y-3">
            {attestations.map((a) => (
              <div
                key={a.attestationId}
                className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3"
              >
                <span className="font-medium text-gray-900 dark:text-white">{a.capability}</span>
                <span className="text-sm font-mono text-gray-500 dark:text-gray-400 truncate" title={a.verifier}>
                  by {a.verifier.slice(0, 4)}…{a.verifier.slice(-4)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
