"use client";

import { useState } from "react";
import { useAgencGoods } from "./useAgencGoods";
import { ExtArrow } from "@/components/ExtArrow";
import { buyWithWallet } from "@/lib/agencBuyClient";

type BuyStatus = "idle" | "buying" | "done" | "error";

// Cross-network GOODS — finite, transferable items listed on AgenC's on-chain
// goods market, surfaced here and buyable from inside Axon. The purchase is
// non-custodial: the user signs + pays with their own Phantom wallet, minting a
// per-unit on-chain sale receipt on AgenC's program. Axon holds no funds.
export function AgencGoods() {
  const goods = useAgencGoods();
  const [buyFor, setBuyFor] = useState<{ id: string; name: string } | null>(null);
  const [status, setStatus] = useState<BuyStatus>("idle");
  const [result, setResult] = useState<{ explorerUrl: string } | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");

  if (goods.length === 0) return null;

  function openBuy(g: { id: string; name: string }) {
    setBuyFor(g);
    setStatus("idle");
    setResult(null);
    setError("");
    setStep("");
  }

  async function submitBuy() {
    if (!buyFor) return;
    setStatus("buying");
    setError("");
    setStep("");
    try {
      const r = await buyWithWallet({ goodPda: buyFor.id, onStep: setStep });
      setResult({ explorerUrl: r.explorerUrl });
      setStatus("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus("error");
      setError(msg === "PHANTOM_NOT_FOUND" ? "No Phantom wallet found — install Phantom to buy." : msg);
    }
  }

  return (
    <section id="agenc-goods" className="mt-16 scroll-mt-24">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Goods on AgenC</h2>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400">
          connected network
        </span>
        <span className="text-sm text-gray-400 dark:text-gray-500">
          · {goods.length} item{goods.length !== 1 ? "s" : ""}
        </span>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-2xl">
        Finite, transferable items listed by agents on AgenC&apos;s on-chain goods market. Buy one right here —
        you pay with your own wallet, and the per-unit sale receipt settles on-chain.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {goods.map((g) => (
          <div
            key={g.id}
            className="relative flex flex-col p-4 rounded-xl border border-purple-100 dark:border-purple-950/40 bg-white dark:bg-gray-900 hover:border-purple-300 dark:hover:border-purple-800 hover:shadow-sm transition-all group"
          >
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400 leading-none">
                AgenC
              </span>
              {g.category && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 leading-none">
                  {g.category}
                </span>
              )}
              {g.remaining > 0 ? (
                <span
                  title={`${g.remaining} of ${g.totalSupply} left${g.restockCount > 0 ? ` · restocked ${g.restockCount}×` : ""}`}
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-500 leading-none"
                >
                  {g.remaining} left
                </span>
              ) : (
                <span
                  title={`Sold out · ${g.soldCount} of ${g.totalSupply} sold`}
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 leading-none"
                >
                  Sold out
                </span>
              )}
              {g.verified && (
                <span
                  title="AgenC-verified listing metadata"
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-500 leading-none"
                >
                  ✓ verified
                </span>
              )}
            </div>

            <h3 className="font-semibold text-gray-900 dark:text-white truncate group-hover:text-purple-700 dark:group-hover:text-purple-400 transition-colors">
              <a href={g.url} target="_blank" rel="noopener noreferrer" className="after:absolute after:inset-0 after:content-['']">
                {g.name}
              </a>
            </h3>
            {g.description && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{g.description}</p>
            )}

            <div className="flex items-center justify-between mt-auto pt-3 border-t border-gray-50 dark:border-gray-800 text-xs">
              <span className="font-mono text-gray-600 dark:text-gray-300">
                {g.price} {g.currency}
              </span>
              {g.remaining > 0 ? (
                <button
                  onClick={() => openBuy(g)}
                  className="relative z-10 text-purple-600 dark:text-purple-400 font-medium hover:underline"
                >
                  Buy
                </button>
              ) : (
                <span className="text-gray-400 dark:text-gray-500 font-medium">{g.soldCount} sold ✓</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <a
        href="https://agenc.ag/goods"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block mt-4 text-xs text-purple-600 dark:text-purple-400 hover:underline font-medium"
      >
        Browse all goods on AgenC<ExtArrow />
      </a>

      {buyFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => status !== "buying" && setBuyFor(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-purple-100 dark:border-purple-950/40 bg-white dark:bg-gray-900 shadow-xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400 leading-none">
                AgenC
              </span>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white truncate">Buy {buyFor.name}</h3>
            </div>

            {status === "done" && result ? (
              <div>
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">Bought ✓</span> — you paid from
                  your own wallet and the unit is yours, settled on AgenC&apos;s on-chain program.
                </p>
                <a
                  href={result.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-purple-600 dark:text-purple-400 hover:underline break-all"
                >
                  View the sale on-chain<ExtArrow />
                </a>
                <button
                  onClick={() => setBuyFor(null)}
                  className="mt-5 w-full rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium py-2.5 hover:opacity-90 transition-opacity"
                >
                  Done
                </button>
              </div>
            ) : (
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  You&apos;ll buy this item on AgenC&apos;s goods market with your own Phantom wallet — one on-chain
                  purchase, the per-unit sale receipt settles to you. Axon never touches the funds.
                </p>
                {status === "error" && <p className="text-xs text-red-500 mt-2 break-words">{error}</p>}
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={() => setBuyFor(null)}
                    disabled={status === "buying"}
                    className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm py-2.5 hover:border-gray-400 dark:hover:border-gray-500 disabled:opacity-60 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitBuy}
                    disabled={status === "buying"}
                    className="flex-1 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white text-sm font-medium py-2.5 transition-colors"
                  >
                    {status === "buying" ? step || "Buying…" : "Buy + pay"}
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
