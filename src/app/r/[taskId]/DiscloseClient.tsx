"use client";

import { useEffect, useState } from "react";

// Selective disclosure — the front of Proof Layer #3. A receipt gets a Merkle
// commitment over its fields + derived predicates; you pick facts to prove and
// get a self-verifying bundle that a third party folds to the root WITHOUT the
// rest of the receipt. Renders nothing until the commitment loads.

interface DisclosableField {
  field: string;
  label: string;
  predicate?: boolean;
}
interface Commitment {
  taskId: string;
  root: string;
  disclosable: DisclosableField[];
  facts: string[]; // predicate fields that are TRUE for this receipt
  method: { algorithm: string; note: string };
}
interface Bundle {
  taskId: string;
  root: string;
  algorithm: string;
  disclosures: { field: string; label: string; value: unknown; predicate: boolean }[];
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export default function DiscloseClient({ taskId }: { taskId: string }) {
  const [commitment, setCommitment] = useState<Commitment | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none">("loading");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [verify, setVerify] = useState<"idle" | "checking" | "ok" | "bad">("idle");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/receipts/${encodeURIComponent(taskId)}/commitment`);
        if (!alive) return;
        if (!res.ok) return setState("none");
        setCommitment((await res.json()) as Commitment);
        setState("ready");
      } catch {
        if (alive) setState("none");
      }
    })();
    return () => { alive = false; };
  }, [taskId]);

  if (state !== "ready" || !commitment) return null;

  function toggle(field: string) {
    setBundle(null);
    setVerify("idle");
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }

  async function build() {
    if (picked.size === 0) return;
    setVerify("checking");
    const fields = [...picked].join(",");
    const res = await fetch(`/api/receipts/${encodeURIComponent(taskId)}/commitment?disclose=${encodeURIComponent(fields)}`);
    if (!res.ok) { setVerify("bad"); return; }
    const b = (await res.json()) as Bundle;
    setBundle(b);
    // prove it end-to-end: hand the bundle straight back to the verifier
    const v = await fetch(`/api/receipts/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    });
    const vr = (await v.json()) as { valid: boolean };
    setVerify(vr.valid ? "ok" : "bad");
  }

  const card = "rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent shadow-2xl overflow-hidden";
  const factSet = new Set(commitment.facts ?? []); // tolerate an older cached commitment
  const predicates = commitment.disclosable.filter((d) => d.predicate);
  // Only TRUE predicates are worth proving; false ones fold to `false`.
  const provable = predicates.filter((d) => factSet.has(d.field));
  const falsePredicates = predicates.filter((d) => !factSet.has(d.field));
  const rawFields = commitment.disclosable.filter((d) => !d.predicate);

  return (
    <div className={`${card} mt-5`}>
      <div className="px-7 pt-6 pb-4 border-b border-white/10">
        <p className="text-[11px] tracking-[0.3em] font-mono text-violet-400">SELECTIVE DISCLOSURE</p>
        <p className="text-[11px] text-gray-500 mt-1">
          Prove one fact from this receipt without revealing the rest — every other field stays an opaque hash.
        </p>
        <p className="text-[11px] text-gray-600 mt-2 font-mono break-all" title={commitment.root}>
          commitment root {short(commitment.root)}
        </p>
      </div>

      <div className="px-7 py-5 space-y-4">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">Provable facts</p>
          {provable.length === 0 ? (
            <p className="text-xs text-gray-500">No predicates are true for this receipt yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {provable.map((d) => {
                const on = picked.has(d.field);
                return (
                  <button
                    key={d.field}
                    onClick={() => toggle(d.field)}
                    className={`text-xs rounded-full border px-3 py-1.5 transition ${
                      on
                        ? "border-violet-400/60 bg-violet-500/20 text-violet-200"
                        : "border-white/10 bg-white/[0.03] text-gray-300 hover:border-white/25"
                    }`}
                  >
                    {on ? "✓ " : ""}{d.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <details className="text-gray-400">
          <summary className="text-[11px] uppercase tracking-wide text-gray-500 cursor-pointer">Or open a raw field</summary>
          <div className="flex flex-wrap gap-2 mt-2">
            {rawFields.map((d) => {
              const on = picked.has(d.field);
              return (
                <button
                  key={d.field}
                  onClick={() => toggle(d.field)}
                  className={`text-xs rounded-full border px-3 py-1.5 transition ${
                    on ? "border-teal-400/60 bg-teal-500/20 text-teal-200" : "border-white/10 bg-white/[0.03] text-gray-400 hover:border-white/25"
                  }`}
                >
                  {on ? "✓ " : ""}{d.label}
                </button>
              );
            })}
            {falsePredicates.map((d) => {
              const on = picked.has(d.field);
              return (
                <button
                  key={d.field}
                  onClick={() => toggle(d.field)}
                  title="This predicate is false for this receipt — disclosing it proves it is false."
                  className={`text-xs rounded-full border px-3 py-1.5 transition opacity-70 ${
                    on ? "border-amber-400/50 bg-amber-500/15 text-amber-200" : "border-white/10 bg-white/[0.02] text-gray-500 hover:border-white/20"
                  }`}
                >
                  {on ? "✓ " : "✗ "}{d.label} <span className="text-gray-600">(false)</span>
                </button>
              );
            })}
          </div>
        </details>

        <button
          onClick={build}
          disabled={picked.size === 0 || verify === "checking"}
          className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 transition"
        >
          {verify === "checking" ? "Building…" : `Create shareable proof${picked.size ? ` (${picked.size})` : ""}`}
        </button>

        {bundle && (
          <div className="rounded-xl border border-white/10 bg-black/30 p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className={`text-xs font-semibold ${verify === "ok" ? "text-emerald-300" : verify === "bad" ? "text-amber-300" : "text-gray-400"}`}>
                {verify === "ok" ? "✓ Verified — folds to the receipt's root" : verify === "bad" ? "✗ Did not verify" : "…"}
              </span>
              <button
                onClick={() => { navigator.clipboard?.writeText(JSON.stringify(bundle, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                className="text-xs text-violet-300 hover:text-violet-200"
              >
                {copied ? "Copied ✓" : "Copy bundle"}
              </button>
            </div>
            <p className="text-[11px] text-gray-500">
              This bundle proves {bundle.disclosures.length} fact{bundle.disclosures.length !== 1 ? "s" : ""} and nothing else.
              Anyone can fold each path to the root — no key, no access to the rest of the receipt.
            </p>
            <pre className="text-[10px] font-mono text-gray-400 overflow-x-auto max-h-52 whitespace-pre-wrap break-all">
              {JSON.stringify(bundle, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div className="px-7 py-4 bg-white/[0.03]">
        <p className="text-[11px] text-gray-500">{commitment.method.note}</p>
      </div>
    </div>
  );
}
