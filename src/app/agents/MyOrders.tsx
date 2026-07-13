"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExtArrow } from "@/components/ExtArrow";
import { fetchDelivery, reclaimWithWallet } from "@/lib/agencReclaimClient";
import type { Delivery } from "@/lib/integrations/agencReclaim";

// My Hires / My Buys — one place a user sees everything they've hired or bought
// across networks from inside Axon. The flow is non-custodial, so the on-chain
// transaction is the source of truth; this panel is the buyer's convenient index
// of it, and every row links to its transaction so the whole history is
// independently verifiable on-chain.

interface Order {
  id: number;
  kind: "hire" | "buy";
  network: string;
  itemPda: string;
  name: string;
  price: string;
  txSig: string;
  status: string;
  createdAt: string;
}

interface Phantom {
  isPhantom?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toBase58: () => string } }>;
  on?: (event: string, handler: (arg: unknown) => void) => void;
  removeListener?: (event: string, handler: (arg: unknown) => void) => void;
}
function getPhantom(): Phantom | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { phantom?: { solana?: Phantom }; solana?: Phantom };
  const p = w.phantom?.solana ?? w.solana;
  return p && p.isPhantom ? p : null;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function MyOrders() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [connecting, setConnecting] = useState(false);
  // the connected wallet, readable from event handlers without re-subscribing
  const walletRef = useRef<string | null>(null);
  // last-write-wins: only the newest fetch may set state, so a slow silent-connect
  // load can never clobber a fresher one (manual connect, or a live refresh)
  const reqSeq = useRef(0);

  const loadFor = useCallback(async (w: string) => {
    const seq = ++reqSeq.current;
    try {
      const r = await fetch(`/api/agenc/orders?wallet=${encodeURIComponent(w)}`);
      const d = (await r.json()) as { orders?: Order[] };
      if (seq === reqSeq.current) setOrders(d.orders ?? []);
    } catch {
      if (seq === reqSeq.current) setOrders([]);
    }
  }, []);

  const adoptWallet = useCallback((w: string) => {
    walletRef.current = w;
    setWallet(w);
    loadFor(w);
  }, [loadFor]);

  // Reload the connected wallet's orders (after a reclaim flips a status).
  const refresh = useCallback(() => { if (walletRef.current) loadFor(walletRef.current); }, [loadFor]);

  // Reset the panel to its connect prompt (used on a wallet disconnect). Bumps
  // the request sequence so any in-flight load for the old wallet is discarded.
  const forgetWallet = useCallback(() => {
    walletRef.current = null;
    reqSeq.current++;
    setWallet(null);
    setOrders(null);
  }, []);

  // Land the #my-orders deep link ON this section. The section sits below the
  // agent grid + cross-network sections, so the browser's initial jump-to-hash
  // fires before the layout settles and misses. Re-scroll once things settle.
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#my-orders") return;
    const t = setTimeout(() => {
      document.getElementById("my-orders")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 350);
    return () => clearTimeout(t);
  }, []);

  // Silent connect on mount: if the wallet already trusts this site, fill the
  // panel without a prompt. Never pops Phantom on its own.
  useEffect(() => {
    const p = getPhantom();
    if (!p) return;
    let alive = true;
    p.connect({ onlyIfTrusted: true })
      .then(({ publicKey }) => { if (alive) adoptWallet(publicKey.toBase58()); })
      .catch(() => {}); // not yet trusted — the connect button handles it
    return () => { alive = false; };
  }, [adoptWallet]);

  // A hire/buy just landed elsewhere on the page → refresh this panel live, so
  // "one place to see everything" actually updates the moment you buy.
  useEffect(() => {
    const onRecorded = () => { if (walletRef.current) loadFor(walletRef.current); };
    window.addEventListener("axon-order-recorded", onRecorded);
    return () => window.removeEventListener("axon-order-recorded", onRecorded);
  }, [loadFor]);

  // Follow the wallet: switching accounts in Phantom reloads this panel for the
  // new account; disconnecting clears it. Without this the panel would keep
  // showing the previous account's orders — the wrong person's history.
  useEffect(() => {
    const p = getPhantom();
    if (!p?.on) return;
    const onAccountChanged = (arg: unknown) => {
      const key = arg as { toBase58?: () => string } | null;
      if (key && typeof key.toBase58 === "function") adoptWallet(key.toBase58());
      else forgetWallet(); // switched to a locked/absent account → back to connect
    };
    p.on("accountChanged", onAccountChanged);
    return () => p.removeListener?.("accountChanged", onAccountChanged);
  }, [adoptWallet, forgetWallet]);

  async function connect() {
    const p = getPhantom();
    if (!p) { window.open("https://phantom.app/", "_blank", "noopener"); return; }
    setConnecting(true);
    try {
      const { publicKey } = await p.connect();
      adoptWallet(publicKey.toBase58());
    } catch {
      // user dismissed the prompt
    } finally {
      setConnecting(false);
    }
  }

  // Nothing to show and not connected → a slim, unobtrusive prompt. Once
  // connected with zero orders it still renders (so a first-time buyer learns
  // the panel exists), just with an empty state.
  const hasOrders = (orders?.length ?? 0) > 0;

  return (
    <section id="my-orders" className="mt-16 scroll-mt-24">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">My cross-network orders</h2>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-teal-100 dark:bg-teal-950/40 text-teal-700 dark:text-teal-400">non-custodial</span>
        {wallet && hasOrders && (
          <span className="text-sm text-gray-400 dark:text-gray-500">· {orders!.length} order{orders!.length !== 1 ? "s" : ""}</span>
        )}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-2xl">
        Everything you&apos;ve hired or bought across networks from inside Axon. You paid with your own wallet, so
        each order is settled on-chain — verify any of them yourself from the link on the row.
      </p>

      {!wallet ? (
        <button
          onClick={connect}
          disabled={connecting}
          className="rounded-xl border-2 border-teal-200 dark:border-teal-900/60 bg-white dark:bg-gray-900 px-4 py-2.5 text-sm font-semibold text-teal-700 dark:text-teal-400 hover:border-teal-400 disabled:opacity-60"
        >
          {connecting ? "Connecting…" : "Connect wallet to see your orders"}
        </button>
      ) : orders === null ? (
        <p className="text-sm text-gray-400">Loading your orders…</p>
      ) : orders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-800 px-4 py-6 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">No cross-network orders yet.</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Hire an AgenC agent or buy a good above and it&apos;ll appear here, with its on-chain receipt.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <OrderRow key={o.id} order={o} onChanged={refresh} />
          ))}
        </div>
      )}
    </section>
  );
}

// Live delivery status per hire + the Reclaim action. A funded hire polls its
// on-chain task status once (awaiting / in_review / delivered / reclaimed); if
// the work never came (awaiting), a Reclaim button pulls the escrow back to the
// buyer's wallet — non-custodial, the buyer signs. Buys and already-reclaimed
// hires just show their static status.
const DELIVERY_LABEL: Record<Delivery["state"], string> = {
  awaiting: "awaiting delivery",
  in_review: "in review",
  delivered: "delivered",
  reclaimed: "reclaimed",
  disputed: "disputed",
  // the task account is closed/unreadable — settled one way or another; the
  // verify link is how you see which. Never "on-chain" (a non-status word).
  gone: "closed",
};

function OrderRow({ order: o, onChanged }: { order: Order; onChanged: () => void }) {
  const isHire = o.kind === "hire";
  const alreadyReclaimed = o.status === "reclaimed";
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [reclaiming, setReclaiming] = useState(false);
  const [err, setErr] = useState("");

  // Read the hire's live on-chain status once (skip buys + already-reclaimed).
  useEffect(() => {
    if (!isHire || alreadyReclaimed) return;
    let alive = true;
    fetchDelivery(o.itemPda).then((d) => { if (alive) setDelivery(d); });
    return () => { alive = false; };
  }, [isHire, alreadyReclaimed, o.itemPda]);

  async function reclaim() {
    setReclaiming(true); setErr("");
    try {
      await reclaimWithWallet({ taskPda: o.itemPda });
      onChanged(); // refresh the list — the order flips to reclaimed
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m === "PHANTOM_NOT_FOUND" ? "No Phantom wallet found." : m);
    } finally {
      setReclaiming(false);
    }
  }

  // The status chip: settled buy, reclaimed hire, or the live delivery state.
  const state: Delivery["state"] | null = alreadyReclaimed ? "reclaimed" : delivery?.state ?? null;
  const chipLabel = !isHire ? "settled" : state ? DELIVERY_LABEL[state] : "funded";
  const good = !isHire ? true : state === "delivered";
  const canReclaim = isHire && !alreadyReclaimed && delivery?.reclaimable === true;

  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
      <span
        className={`text-[10px] font-bold px-2 py-1 rounded leading-none shrink-0 ${
          isHire
            ? "bg-pink-100 dark:bg-pink-950/40 text-pink-700 dark:text-pink-400"
            : "bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400"
        }`}
      >
        {isHire ? "HIRE" : "BUY"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{o.name}</p>
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {o.price} · {timeAgo(o.createdAt)}{err ? <span className="text-red-500"> · {err}</span> : null}
        </p>
      </div>
      {canReclaim && (
        <button
          onClick={reclaim}
          disabled={reclaiming}
          title="This hire hasn't been delivered — reclaim your escrow on-chain"
          className="text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/50 disabled:opacity-60 shrink-0"
        >
          {reclaiming ? "Reclaiming…" : "Reclaim"}
        </button>
      )}
      <span
        className={`text-[10px] font-medium px-1.5 py-0.5 rounded leading-none shrink-0 ${
          good
            ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-500"
            : state === "reclaimed"
              ? "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
              : "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-500"
        }`}
        title={isHire ? "Live on-chain delivery status of this hire" : "Sale settled on-chain"}
      >
        {chipLabel}
      </span>
      <a
        href={`https://solscan.io/tx/${o.txSig}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-gray-400 dark:text-gray-500 hover:text-teal-600 dark:hover:text-teal-400 shrink-0"
      >
        verify<ExtArrow />
      </a>
    </div>
  );
}
