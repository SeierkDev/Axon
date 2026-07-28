"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { collectPaymentInstrument, UnsupportedHandlerError, type HandlerDescriptor, type PaymentInstrument } from "./paymentHandlers";

// What a buyer sees when their agent wants to spend their money.
//
// Approving is signing: the wallet signs the exact purchase, and that signature
// is what the business validates. So this screen never asks for a card, never
// shows one, and can't approve anything without the buyer's own key.

interface Intent {
  intentId: string;
  agentId: string;
  businessHost: string;
  summary: string;
  amount: number;
  currency: string;
  status: "proposed" | "approved" | "purchased" | "declined" | "expired" | "failed";
  preCleared?: boolean;
  orderId?: string;
  orderStatus?: string;
  signed?: boolean;
  expiresAt: string;
  createdAt: string;
  failure?: string;
}

interface Profile {
  profileId: string;
  label: string;
  status: "active" | "frozen" | "deleted";
}

interface Mandate {
  mandateId: string;
  agentId: string;
  profileId: string;
  maxPerPurchase: number;
  maxPerPeriod: number;
  period: string;
  currency: string;
  status: "active" | "revoked";
  spentThisPeriod?: number;
}

interface Summary {
  purchased: number;
  totalSpent: number;
  pending: number;
  currency: string;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
}

function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : null;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const money = (n: number, c: string) => `${n.toFixed(2)} ${c}`;

function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h left` : `${m}m left`;
}

const STATUS_STYLE: Record<Intent["status"], string> = {
  proposed: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  approved: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30",
  purchased: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/30",
  declined: "bg-gray-500/10 text-gray-500 border-gray-500/30",
  expired: "bg-gray-500/10 text-gray-500 border-gray-500/30",
  failed: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
};

export default function CommerceClient() {
  const [apiKey, setApiKey] = useState("");
  const [intents, setIntents] = useState<Intent[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [form, setForm] = useState({
    label: "Home", name: "", email: "", line1: "", city: "", postalCode: "", country: "",
    agentId: "", maxPerPurchase: "100", maxPerPeriod: "300",
  });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const auth = useCallback(() => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }), [apiKey]);

  const load = useCallback(async () => {
    if (!apiKey.trim()) return;
    setState("loading");
    setError(null);
    try {
      const [res, profRes, mandRes] = await Promise.all([
        fetch("/api/commerce/intents?limit=100&refresh=1", { headers: auth() }),
        fetch("/api/commerce/profiles", { headers: auth() }),
        fetch("/api/commerce/mandates", { headers: auth() }),
      ]);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const data = (await res.json()) as { intents: Intent[]; summary: Summary };
      setIntents(data.intents);
      setSummary(data.summary);
      if (profRes.ok) setProfiles(((await profRes.json()) as { profiles: Profile[] }).profiles);
      if (mandRes.ok) setMandates(((await mandRes.json()) as { mandates: Mandate[] }).mandates);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load purchases");
      setState("error");
    }
  }, [apiKey, auth]);

  // Keep the list fresh while it's open — an agent can propose at any moment.
  useEffect(() => {
    if (state !== "ready") return;
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [state, load]);

  async function decide(intent: Intent, decision: "approve" | "decline") {
    setBusy(intent.intentId);
    setError(null);
    try {
      let signature: string | undefined;
      let paymentInstrument: PaymentInstrument | undefined;

      if (decision === "approve") {
        const phantom = getPhantom();
        if (!phantom) throw new Error("Phantom wallet not found — approving a purchase requires signing it.");
        await phantom.connect();

        // Fetch the exact text to sign. It names the cart, the price, the
        // ceiling and the deadline, so what's signed is what's shown.
        const msgRes = await fetch(`/api/commerce/intents/${intent.intentId}/decision`, { headers: auth() });
        if (!msgRes.ok) throw new Error("Could not load the authorisation to sign");
        const { message } = (await msgRes.json()) as { message: string };

        const signed = await phantom.signMessage(new TextEncoder().encode(message), "utf8");
        signature = b64(signed.signature);

        // Signing authorises the purchase; it doesn't pay for it. The card is
        // collected by the business's own payment handler, in this browser —
        // Axon forwards the credential and never sees a card number.
        const payRes = await fetch(`/api/commerce/intents/${intent.intentId}/payment`, { headers: auth() });
        if (payRes.ok) {
          const pay = (await payRes.json()) as {
            paymentHandlers: HandlerDescriptor[]; total: number; currency: string; approvedCeiling: number;
          };
          // Refuse a total that drifted past what the buyer just signed for,
          // before opening a payment sheet rather than after.
          if (pay.total > pay.approvedCeiling) {
            throw new Error(
              `The price moved to ${pay.total.toFixed(2)} ${pay.currency}, above what you approved. Nothing was charged.`,
            );
          }
          try {
            paymentInstrument = await collectPaymentInstrument(pay.paymentHandlers, {
              total: pay.total,
              currency: pay.currency,
              businessHost: intent.businessHost,
            });
          } catch (err) {
            // No usable handler isn't a failure of the approval — the consent is
            // still recorded, so say what happened and keep going.
            if (!(err instanceof UnsupportedHandlerError)) throw err;
            setError(err.message);
          }
        }
      }

      const res = await fetch(`/api/commerce/intents/${intent.intentId}/decision`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          decision,
          ...(signature ? { signature } : {}),
          ...(paymentInstrument ? { paymentInstrument } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; purchaseError?: string };
      if (res.status === 202) {
        // Authorised but not charged — a real state, not a failure.
        setError(data.purchaseError ?? "Approved and signed, but no payment could be taken yet.");
        return;
      }
      if (!res.ok) {
        // 502 means it was approved and signed but the store didn't complete —
        // say that, because it's retryable and the consent still stands.
        throw new Error(data.purchaseError ?? data.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
      void load();
    }
  }

  async function post(path: string, body: unknown, label: string) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(path, { method: "POST", headers: auth(), body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
      void load();
    }
  }

  const activeProfile = profiles.find((p) => p.status === "active") ?? null;

  async function stopEverything() {
    if (!confirm("Stop all agent spending? This revokes every budget and voids anything waiting for approval.")) return;
    setBusy("kill");
    try {
      await fetch("/api/commerce/kill", { method: "POST", headers: auth() });
    } finally {
      setBusy(null);
      void load();
    }
  }

  const waiting = intents.filter((i) => i.status === "proposed");
  const rest = intents.filter((i) => i.status !== "proposed");

  return (
    <div className="max-w-4xl mx-auto px-6 pt-32 pb-24">
      <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">AGENT CHECKOUT</p>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Purchases</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8">
        What your agents want to buy, and what they already bought. Approving a purchase means signing it with your
        wallet — nothing is charged without that signature.
      </p>

      {/* Before the key, this page has nothing of yours to show — so it explains
          the thing instead of presenting a bare input with no context. */}
      {state === "idle" || state === "error" ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-1">How your agent shops</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
            Give an agent the <code className="font-mono text-xs">commerce</code> grant and it can search real stores
            and propose what to buy. It has no tool that spends money — that part is always you.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
            {([
              ["It shops", "Searches real businesses and comes back with real prices and stock."],
              ["You cap it", "One budget: per purchase, per period, which categories. Plus a kill switch."],
              ["You sign", "Your wallet signs the exact purchase. No signature, no charge."],
            ] as const).map(([label, body], i) => (
              <div key={label} className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-gray-300 dark:text-gray-600">{String(i + 1).padStart(2, "0")}</span>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{label}</h3>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/publish"
              className="px-4 py-2 rounded-lg bg-[#0a0a0a] dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium hover:bg-[#222] dark:hover:bg-gray-200 transition-colors"
            >
              Give an agent the commerce grant
            </Link>
            <Link
              href="/docs/guides/agent-commerce"
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm font-medium hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-all"
            >
              Read the guide
            </Link>
          </div>
        </div>
      ) : null}

      {state === "idle" || state === "error" ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 mb-8">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Your API key</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Already set up? Load your agents&apos; purchases.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void load()}
              placeholder="axon_…"
              className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm font-mono"
            />
            <button
              onClick={() => void load()}
              className="px-4 py-2 rounded-lg bg-[#0a0a0a] dark:bg-white dark:text-[#0a0a0a] text-white text-sm font-medium"
            >
              Load
            </button>
          </div>
        </div>
      ) : null}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 mb-6 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          <Stat label="Awaiting you" value={String(summary.pending)} />
          <Stat label="Purchases" value={String(summary.purchased)} />
          <Stat label="Total spent" value={money(summary.totalSpent, summary.currency)} />
        </div>
      )}

      {/* Setup — a purchase needs somewhere to ship and a budget to spend. Shown
          until both exist, so granting the tool isn't a dead end. */}
      {state === "ready" && !activeProfile && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 mb-8">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">1. Where your orders go</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Encrypted before it&apos;s stored, and never shown to an agent or written to a receipt.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {([
              ["name", "Full name"], ["email", "Email"], ["line1", "Street address"],
              ["city", "City"], ["postalCode", "Postcode"], ["country", "Country (2-letter, e.g. GB)"],
            ] as const).map(([k, ph]) => (
              <input
                key={k}
                value={form[k]}
                onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                placeholder={ph}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm"
              />
            ))}
          </div>
          <button
            disabled={busy === "profile"}
            onClick={() =>
              void post("/api/commerce/profiles", {
                label: form.label,
                contact: { name: form.name, email: form.email },
                address: {
                  line1: form.line1, city: form.city,
                  postalCode: form.postalCode, country: form.country.toUpperCase(),
                },
              }, "profile")
            }
            className="mt-3 px-4 py-2 rounded-lg bg-[#0a0a0a] dark:bg-white dark:text-[#0a0a0a] text-white text-sm font-medium disabled:opacity-50"
          >
            {busy === "profile" ? "Saving…" : "Save delivery details"}
          </button>
        </div>
      )}

      {state === "ready" && activeProfile && mandates.filter((m) => m.status === "active").length === 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 mb-8">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">2. What an agent may spend</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            A standing budget. Separate from approving any one purchase — you still sign each of those.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <input
              value={form.agentId}
              onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
              placeholder="agent id"
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm font-mono"
            />
            <input
              value={form.maxPerPurchase}
              onChange={(e) => setForm((f) => ({ ...f, maxPerPurchase: e.target.value }))}
              placeholder="max per purchase"
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm"
            />
            <input
              value={form.maxPerPeriod}
              onChange={(e) => setForm((f) => ({ ...f, maxPerPeriod: e.target.value }))}
              placeholder="max per month"
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm"
            />
          </div>
          <button
            disabled={busy === "mandate"}
            onClick={() =>
              void post("/api/commerce/mandates", {
                agentId: form.agentId.trim(),
                profileId: activeProfile.profileId,
                maxPerPurchase: Number(form.maxPerPurchase),
                maxPerPeriod: Number(form.maxPerPeriod),
              }, "mandate")
            }
            className="mt-3 px-4 py-2 rounded-lg bg-[#0a0a0a] dark:bg-white dark:text-[#0a0a0a] text-white text-sm font-medium disabled:opacity-50"
          >
            {busy === "mandate" ? "Granting…" : "Grant budget"}
          </button>
        </div>
      )}

      {/* Live budgets, so an owner can see what they've handed out. */}
      {mandates.filter((m) => m.status === "active").length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden mb-8">
          {mandates.filter((m) => m.status === "active").map((m) => (
            <div key={m.mandateId} className="px-5 py-3 border-b last:border-b-0 border-gray-100 dark:border-gray-800 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-mono text-gray-900 dark:text-white">{m.agentId}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  up to {m.maxPerPurchase} per purchase · {(m.spentThisPeriod ?? 0).toFixed(2)} of {m.maxPerPeriod} {m.currency} this {m.period}
                </p>
              </div>
              <button
                onClick={async () => {
                  setBusy(m.mandateId);
                  try {
                    await fetch(`/api/commerce/mandates?id=${m.mandateId}`, { method: "DELETE", headers: auth() });
                  } finally { setBusy(null); void load(); }
                }}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      {state === "ready" && waiting.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">Nothing is waiting on you.</p>
      )}

      {waiting.map((i) => (
        <div key={i.intentId} className="rounded-xl border border-amber-500/30 bg-amber-500/[0.03] p-5 mb-4">
          <div className="flex items-start justify-between gap-4 mb-2">
            <div>
              <p className="text-lg font-semibold text-gray-900 dark:text-white">{i.summary}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                {i.businessHost} · proposed by <span className="font-mono">{i.agentId}</span>
              </p>
              {i.preCleared && (
                <p className="text-xs text-teal-700 dark:text-teal-400 mt-1">
                  Within your budget&apos;s threshold — no decision needed, just your signature.
                </p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="text-xl font-bold text-gray-900 dark:text-white font-mono">{money(i.amount, i.currency)}</p>
              <p className="text-xs text-amber-600 dark:text-amber-400">{timeLeft(i.expiresAt)}</p>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button
              disabled={busy === i.intentId}
              onClick={() => void decide(i, "approve")}
              className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
            >
              {busy === i.intentId ? "Approving…" : "Approve and pay"}
            </button>
            <button
              disabled={busy === i.intentId}
              onClick={() => void decide(i, "decline")}
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm font-medium disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      ))}

      {rest.length > 0 && (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mt-10 mb-3">
            History
          </h2>
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            {rest.map((i) => (
              <div key={i.intentId} className="px-5 py-3 border-b last:border-b-0 border-gray-100 dark:border-gray-800 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-gray-900 dark:text-white truncate">{i.summary}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {i.businessHost}
                    {i.orderStatus ? ` · ${i.orderStatus}` : ""}
                    {i.failure ? ` · ${i.failure}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-mono text-gray-600 dark:text-gray-400">{money(i.amount, i.currency)}</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATUS_STYLE[i.status]}`}>{i.status}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {state === "ready" && (
        <div className="mt-10 pt-6 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between gap-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Stops all spending immediately: revokes every budget and voids anything waiting.
          </p>
          <button
            disabled={busy === "kill"}
            onClick={() => void stopEverything()}
            className="px-4 py-2 rounded-lg border border-red-500/40 text-red-600 dark:text-red-400 text-sm font-medium disabled:opacity-50 shrink-0"
          >
            Stop all spending
          </button>
        </div>
      )}

      <p className="mt-8 text-xs text-gray-400 dark:text-gray-500">
        Give an agent the <code className="font-mono">commerce</code> grant and a budget to let it shop for you —{" "}
        <Link href="/docs/guides/agent-commerce" className="underline hover:text-gray-600 dark:hover:text-gray-300">
          see the guide
        </Link>
        .
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3">
      <p className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="text-lg font-semibold text-gray-900 dark:text-white font-mono mt-0.5">{value}</p>
    </div>
  );
}
