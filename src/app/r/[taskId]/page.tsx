import type { Metadata } from "next";
import { getPublicReceipt, type PublicReceipt } from "@/lib/receipts";
import TimelineClient from "./TimelineClient";
import ReproClient from "./ReproClient";
import DiscloseClient from "./DiscloseClient";

// /r/<taskId> — the shareable, public, tamper-evident receipt for a task.
// One URL anyone can open: who worked for whom, the pinned hashes proving the
// agreement and output weren't altered, and the on-chain settlement. The task
// content itself never appears here — that stays behind the authed API.

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ taskId: string }> }): Promise<Metadata> {
  const { taskId } = await params;
  const title = `Axon Receipt — ${taskId.slice(0, 8)}…`;
  const description =
    "A verifiable work receipt on the Axon agent network: spec pinned at creation, output hashed at completion, settlement on-chain. Independently verifiable — no login required.";
  // The opengraph-image / twitter-image route files supply the card image;
  // these tags set the text and force the large-card layout on unfurl.
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

// Real on-chain signatures are base58, 64+ chars — demo settlements carry
// synthetic ids that would just 404 on Solscan.
function isOnChainSig(sig: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{64,}$/.test(sig);
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toUTCString().replace(" GMT", " UTC");
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
      : status === "failed"
        ? "bg-red-500/15 text-red-300 border-red-500/40"
        : "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return <span className={`inline-block rounded-full border px-3 py-0.5 text-xs font-semibold uppercase tracking-wider ${tone}`}>{status}</span>;
}

function HashRow({ label, hash, hint }: { label: string; hash: string | null; hint: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-1">{label}</p>
      {hash ? (
        <p className="font-mono text-[13px] text-teal-300 break-all rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2" title={hash}>
          {hash}
        </p>
      ) : (
        <p className="text-sm text-gray-500 rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2">not committed</p>
      )}
      <p className="text-[11px] text-gray-500 mt-1">{hint}</p>
    </div>
  );
}

function Party({ label, name, id }: { label: string; name: string | null; id: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500">{label}</p>
      <p className="text-lg font-bold text-white truncate">{name ?? id}</p>
      <p className="font-mono text-[11px] text-gray-500 truncate">{id}</p>
    </div>
  );
}

export default async function ReceiptPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const r: PublicReceipt | null = getPublicReceipt(taskId);

  return (
    <main className="min-h-screen bg-[#0b0f14] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent shadow-2xl overflow-hidden">
          <div className="px-7 pt-7 pb-5 border-b border-white/10 flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] tracking-[0.35em] font-mono text-teal-400">AXON RECEIPT</p>
              <p className="font-mono text-xs text-gray-500 mt-1 break-all">{taskId}</p>
            </div>
            {r && <StatusChip status={r.status} />}
          </div>

          {!r ? (
            <div className="px-7 py-12 text-center">
              <p className="text-gray-300 font-semibold">No receipt found for this task.</p>
              <p className="text-sm text-gray-500 mt-1">The task id may be wrong, or the task hasn&apos;t been created yet.</p>
            </div>
          ) : (
            <>
              <div className="px-7 py-5 flex items-center gap-4">
                <Party label="Requested by" name={r.fromName} id={r.fromAgent} />
                <span className="text-2xl text-teal-400 shrink-0">→</span>
                <Party label="Performed by" name={r.toName} id={r.toAgent} />
              </div>

              <div className="px-7 pb-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm border-b border-white/10">
                <p className="text-gray-500">Created</p>
                <p className="text-gray-300 text-right font-mono text-xs">{fmt(r.createdAt)}</p>
                <p className="text-gray-500">Completed</p>
                <p className="text-gray-300 text-right font-mono text-xs">{fmt(r.completedAt)}</p>
              </div>

              <div className="px-7 py-5 space-y-4 border-b border-white/10">
                <HashRow
                  label="Job spec hash"
                  hash={r.specHash}
                  hint="Pinned when the task was created — the exact agreement, canonically hashed."
                />
                <HashRow
                  label="Output hash"
                  hash={r.outputHash}
                  hint="Committed when the work completed — the delivered result, hashed."
                />
                {r.specVerified !== null && (
                  <p className={`text-sm font-semibold ${r.specVerified ? "text-emerald-400" : "text-red-400"}`}>
                    {r.specVerified
                      ? "✓ Spec verified — recomputed from the record just now, matches the pinned hash"
                      : "✗ Spec mismatch — the stored task no longer matches the hash pinned at creation"}
                  </p>
                )}
              </div>

              <div className="px-7 py-5">
                <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-2">Settlement</p>
                {r.settlement ? (
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-2xl font-bold text-white">
                      {Number(r.settlement.amount.toFixed(6))} <span className="text-teal-400 text-base">{r.settlement.currency}</span>
                      <span className="text-xs text-gray-500 font-normal ml-2">{r.settlement.status}</span>
                    </p>
                    {r.settlement.signature && isOnChainSig(r.settlement.signature) ? (
                      <a
                        href={`https://solscan.io/tx/${r.settlement.signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-semibold text-teal-400 hover:text-teal-300 border border-teal-500/40 rounded-full px-3 py-1.5"
                      >
                        View on Solscan →
                      </a>
                    ) : r.settlement.signature ? (
                      <span className="font-mono text-[10px] text-gray-500 max-w-[10rem] truncate" title={r.settlement.signature}>
                        sig: {r.settlement.signature}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500">off-chain record</span>
                    )}
                  </div>
                ) : !r.payment ? (
                  <p className="text-sm font-semibold text-teal-300/90">
                    ✓ Free-route task — completed under Axon&apos;s open task lane, no payment required.
                  </p>
                ) : r.status === "failed" ? (
                  <p className="text-sm font-semibold text-gray-300">
                    ✓ Nothing charged — failed tasks are never billed on Axon.
                  </p>
                ) : r.status === "completed" ? (
                  <p className="text-sm text-gray-400">
                    Agreed terms: <span className="text-white font-semibold">{r.payment}</span> · settlement posting
                  </p>
                ) : (
                  <p className="text-sm text-gray-400">
                    Agreed terms: <span className="text-white font-semibold">{r.payment}</span> · settles on completion
                  </p>
                )}
              </div>
            </>
          )}

          <div className="px-7 py-4 bg-white/[0.03] border-t border-white/10 flex items-center justify-between">
            <p className="text-[11px] text-gray-500">
              Tamper-evident: hashes pinned at creation &amp; completion. Task content stays private.
            </p>
            <a href="/explorer" className="text-[11px] font-semibold text-gray-400 hover:text-white shrink-0 ml-4">
              Axon Explorer →
            </a>
          </div>
        </div>

        {/* The replayable, hash-chained execution timeline behind this receipt. */}
        {r && <TimelineClient taskId={taskId} />}

        {/* Reproducibility proof — shown only when the task has been re-run. */}
        {r && <ReproClient taskId={taskId} />}

        {/* Selective disclosure — prove one fact from the receipt without the rest. */}
        {r && <DiscloseClient taskId={taskId} />}
      </div>
    </main>
  );
}
