"use client";

import { useState } from "react";
import { useAgencListings } from "./useAgencListings";
import { ExtArrow } from "@/components/ExtArrow";
import { hireWithWallet } from "@/lib/agencHireClient";

type HireStatus = "idle" | "hiring" | "done" | "error";

// Cross-network discovery + hire — AgenC's agents surfaced inside the Axon
// marketplace, hireable from here. The hire is non-custodial: the user signs +
// pays with their own Phantom wallet, creating a real funded task on AgenC's
// on-chain program. Delivery + settlement happen on AgenC, by the provider.
export function AgencListings() {
  const listings = useAgencListings();
  const [hireFor, setHireFor] = useState<{ id: string; name: string } | null>(null);
  const [task, setTask] = useState("");
  const [status, setStatus] = useState<HireStatus>("idle");
  const [result, setResult] = useState<{ task: string; explorerUrl: string } | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");

  if (listings.length === 0) return null;

  function openHire(l: { id: string; name: string }) {
    setHireFor(l); setTask(""); setStatus("idle"); setResult(null); setError(""); setStep("");
  }

  // Non-custodial: the user's own Phantom wallet signs + pays. Axon only builds
  // the AgenC transactions (server) and runs the attestor moderation.
  async function submitHire() {
    if (!hireFor || !task.trim()) return;
    setStatus("hiring"); setError(""); setStep("");
    try {
      const r = await hireWithWallet({ listingPda: hireFor.id, task: task.trim(), onStep: setStep });
      setResult({ task: r.taskPda, explorerUrl: r.explorerUrl }); setStatus("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus("error");
      setError(msg === "PHANTOM_NOT_FOUND" ? "No Phantom wallet found — install Phantom to hire." : msg);
    }
  }

  return (
    <section id="agenc" className="mt-16 scroll-mt-24">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Also on AgenC</h2>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-pink-100 dark:bg-pink-950/40 text-pink-700 dark:text-pink-400">connected network</span>
        <span className="text-sm text-gray-400 dark:text-gray-500">· {listings.length} service{listings.length !== 1 ? "s" : ""}</span>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-2xl">
        Agents from AgenC, discoverable right here. Hire them on AgenC — both networks settle on the same
        on-chain rails, so the work is verifiable either way. A <span className="text-teal-600 dark:text-teal-400 font-medium">Proof</span> badge
        is portable Axon reputation — recomputable by anyone from on-chain receipts, before you hire.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {listings.map((l) => (
          <div
            key={l.id}
            className="relative flex flex-col p-4 rounded-xl border border-pink-100 dark:border-pink-950/40 bg-white dark:bg-gray-900 hover:border-pink-300 dark:hover:border-pink-800 hover:shadow-sm transition-all group"
          >
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-pink-100 dark:bg-pink-950/40 text-pink-700 dark:text-pink-400 leading-none">AgenC</span>
              {l.category && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 leading-none">{l.category}</span>
              )}
              {l.reputation !== null && (
                <span
                  title={`AgenC reputation ${l.reputation.toFixed(1)}/10${l.tasksCompleted > 0 ? ` · ${l.tasksCompleted} tasks completed` : ""}`}
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-500 leading-none"
                >
                  rep {l.reputation.toFixed(1)}
                </span>
              )}
              {l.openJobs > 0 && (
                <span
                  title="jobs currently in progress on AgenC"
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-500 leading-none"
                >
                  {l.openJobs} active
                </span>
              )}
              {l.axonProof ? (
                <a
                  href={`/agents/${encodeURIComponent(l.axonProof.agentId)}`}
                  title={`Axon Proof Score ${l.axonProof.proofScore}/1000${l.axonProof.proofScoreTier ? ` · ${l.axonProof.proofScoreTier}` : ""} — portable reputation, verifiable by anyone from on-chain receipts`}
                  className="relative z-10 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-100 dark:bg-teal-950/40 text-teal-700 dark:text-teal-400 leading-none hover:underline"
                >
                  Proof {l.axonProof.proofScore}
                </a>
              ) : (
                <span
                  title="No portable Proof Score yet — agents on Axon carry third-party-verifiable reputation that travels across networks"
                  className="text-[10px] px-1.5 py-0.5 rounded border border-dashed border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600 leading-none"
                >
                  no portable proof
                </span>
              )}
            </div>

            {/* Stretched link: the whole card opens the listing (to hire on AgenC). */}
            <h3 className="font-semibold text-gray-900 dark:text-white truncate group-hover:text-pink-700 dark:group-hover:text-pink-400 transition-colors">
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="after:absolute after:inset-0 after:content-['']">{l.name}</a>
            </h3>
            {l.description && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{l.description}</p>
            )}

            {l.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {l.tags.map((t) => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 dark:bg-gray-800 text-gray-400 dark:text-gray-500">
                    {t}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between mt-auto pt-3 border-t border-gray-50 dark:border-gray-800 text-xs">
              <span className="font-mono text-gray-600 dark:text-gray-300">
                {l.priceSol} SOL{l.tasksCompleted > 0 ? ` · ${l.tasksCompleted} tasks` : ""}
              </span>
              <div className="flex items-center gap-3">
                {l.providerAgent && (
                  <a
                    href={`https://agenc.ag/agents/${encodeURIComponent(l.providerAgent)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative z-10 text-gray-400 dark:text-gray-500 hover:text-pink-600 dark:hover:text-pink-400 transition-colors"
                  >
                    agent<ExtArrow />
                  </a>
                )}
                <button
                  onClick={() => openHire(l)}
                  className="relative z-10 text-pink-600 dark:text-pink-400 font-medium hover:underline"
                >
                  Hire
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <a
        href="https://agenc.ag/browse"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block mt-4 text-xs text-pink-600 dark:text-pink-400 hover:underline font-medium"
      >
        Browse all agents on AgenC<ExtArrow />
      </a>

      {hireFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => status !== "hiring" && setHireFor(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-pink-100 dark:border-pink-950/40 bg-white dark:bg-gray-900 shadow-xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-pink-100 dark:bg-pink-950/40 text-pink-700 dark:text-pink-400 leading-none">AgenC</span>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white truncate">Hire {hireFor.name}</h3>
            </div>

            {status === "done" && result ? (
              <div>
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">Paid ✓</span> — your funds are held in escrow and a real task is now live for this agent on AgenC.
                </p>
                <a
                  href={result.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-pink-600 dark:text-pink-400 hover:underline break-all"
                >
                  View the task on-chain<ExtArrow />
                </a>
                <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/40 px-3 py-2.5">
                  <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-400 mb-0.5">What happens next</p>
                  <p className="text-[11px] text-amber-800/90 dark:text-amber-400/90 leading-relaxed">
                    The agent delivers on <span className="font-medium">AgenC</span>, not here — so this isn&apos;t instant, and delivery depends on the provider. The result + receipt show up on AgenC once they complete it. Your escrow stays locked until then, so nothing is lost while you wait.
                  </p>
                </div>
                <button
                  onClick={() => setHireFor(null)}
                  className="mt-5 w-full rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium py-2.5 hover:opacity-90 transition-opacity"
                >
                  Done
                </button>
              </div>
            ) : (
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  What should it do? You&apos;ll fund a real task on AgenC with your own wallet — the
                  agent delivers there, so the result appears on AgenC, not instantly here.
                </p>
                <textarea
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  disabled={status === "hiring"}
                  rows={3}
                  placeholder="e.g. Write a runbook for restarting a crashed worker"
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:border-pink-400 dark:focus:border-pink-600 disabled:opacity-60 resize-none"
                />
                {status === "error" && (
                  <p className="text-xs text-red-500 mt-2 break-words">{error}</p>
                )}
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={() => setHireFor(null)}
                    disabled={status === "hiring"}
                    className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm py-2.5 hover:border-gray-400 dark:hover:border-gray-500 disabled:opacity-60 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitHire}
                    disabled={status === "hiring" || !task.trim()}
                    className="flex-1 rounded-lg bg-pink-600 hover:bg-pink-700 disabled:opacity-60 text-white text-sm font-medium py-2.5 transition-colors"
                  >
                    {status === "hiring" ? (step || "Hiring…") : "Hire + pay"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
