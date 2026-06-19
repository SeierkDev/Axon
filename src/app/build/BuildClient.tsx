"use client";

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { payForBuild } from "@/lib/buildPaymentClient";

// Price per generation. Keep in sync with BUILD_PRICE in src/app/api/build/route.ts.
const BUILD_PRICE_USDC = 5;

function IconExpand() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
      <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
  );
}

function IconCompress() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
      <line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>
    </svg>
  );
}

const PIPELINE = [
  { id: "build-orchestrator", name: "Orchestrator", label: "Writing game brief"     },
  { id: "build-designer",     name: "Designer",     label: "Designing mechanics"    },
  { id: "build-world",        name: "World",        label: "Designing world layout" },
  { id: "build-coder",        name: "Coder",        label: "Building the game"      },
  { id: "build-artist",       name: "Artist",       label: "Styling the game"       },
  { id: "build-qa",           name: "QA",           label: "Testing the game"       },
] as const;

const EXAMPLES = [
  "A space shooter where you blast waves of aliens, dodge their bullets, and survive to a boss",
  "A top-down dungeon crawler where you collect keys, dodge skeletons, and reach the exit",
  "An arena survival game where you dodge endless waves of enemies and grab powerups to last",
  "A side-scrolling platformer where you jump between platforms, stomp enemies, and collect coins",
];

// Build is 2D today; a prompt asking for 3D gets a heads-up (not a block).
function mentions3D(prompt: string): boolean {
  return /\b3-?d\b|three[\s-]?dimensional|first[\s-]?person|\bvoxel\b/i.test(prompt);
}

const HISTORY_KEY = "axon.build.history";
const HISTORY_MAX = 3;
const EMPTY_HISTORY: HistoryEntry[] = [];

interface HistoryEntry {
  prompt: string;
  html: string;
  ts: number;
  buildId?: string;
}

function readHistory(): HistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return EMPTY_HISTORY;
    return parsed
      .filter((e): e is HistoryEntry =>
        !!e && typeof e === "object"
        && typeof (e as HistoryEntry).prompt === "string"
        && typeof (e as HistoryEntry).html === "string"
        && typeof (e as HistoryEntry).ts === "number")
      .slice(0, HISTORY_MAX);
  } catch {
    return EMPTY_HISTORY;
  }
}

// localStorage-backed store, read via useSyncExternalStore. The snapshot is cached
// against the raw string so getSnapshot stays referentially stable across renders.
const historyListeners = new Set<() => void>();
let historySnapshot: HistoryEntry[] = EMPTY_HISTORY;
let historyRaw: string | null = null;

function refreshHistorySnapshot() {
  const raw = typeof window === "undefined" ? "[]" : localStorage.getItem(HISTORY_KEY) ?? "[]";
  if (raw !== historyRaw) {
    historyRaw = raw;
    historySnapshot = readHistory();
  }
}

function subscribeHistory(cb: () => void) {
  historyListeners.add(cb);
  return () => { historyListeners.delete(cb); };
}

function getHistorySnapshot(): HistoryEntry[] {
  refreshHistorySnapshot();
  return historySnapshot;
}

function getHistoryServerSnapshot(): HistoryEntry[] {
  return EMPTY_HISTORY;
}

function pushHistory(prompt: string, html: string, buildId?: string) {
  const next = [
    { prompt, html, ts: Date.now(), buildId },
    ...readHistory().filter(e => e.prompt !== prompt),
  ].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable or over quota — history is best-effort
  }
  historyRaw = null; // force snapshot recompute on next read
  refreshHistorySnapshot();
  historyListeners.forEach(l => l());
}

// A paid build that hasn't completed yet, persisted so a page refresh mid-build
// can resume it (re-submitting the signature returns the finished game or
// reconnects, without re-charging) instead of orphaning the payment.
// Name the downloaded file after the prompt instead of a generic game.html.
function downloadFileName(prompt: string): string {
  const slug = prompt
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "game"}.html`;
}

const PENDING_PAYMENT_KEY = "axon.build.pendingPayment";

interface PendingPayment {
  signature: string;
  payer: string;
  prompt: string;
}

const pendingListeners = new Set<() => void>();
let pendingSnapshot: PendingPayment | null = null;
let pendingRaw: string | null = null;

function refreshPendingSnapshot() {
  const raw = typeof window === "undefined" ? null : localStorage.getItem(PENDING_PAYMENT_KEY);
  if (raw !== pendingRaw) {
    pendingRaw = raw;
    try {
      const p = raw ? (JSON.parse(raw) as Partial<PendingPayment>) : null;
      pendingSnapshot =
        p && typeof p.signature === "string" && typeof p.payer === "string"
          ? { signature: p.signature, payer: p.payer, prompt: typeof p.prompt === "string" ? p.prompt : "" }
          : null;
    } catch {
      pendingSnapshot = null;
    }
  }
}

function subscribePendingPayment(cb: () => void) {
  pendingListeners.add(cb);
  return () => { pendingListeners.delete(cb); };
}
function getPendingPaymentSnapshot(): PendingPayment | null {
  refreshPendingSnapshot();
  return pendingSnapshot;
}
function getPendingPaymentServerSnapshot(): PendingPayment | null {
  return null;
}
function setPendingPayment(p: PendingPayment | null) {
  try {
    if (p) localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_PAYMENT_KEY);
  } catch {
    /* best-effort */
  }
  pendingRaw = null;
  refreshPendingSnapshot();
  pendingListeners.forEach((l) => l());
}

type Phase = "idle" | "building" | "done" | "error";

interface AgentState {
  status: "pending" | "running" | "done";
  attempt: number;
  passed?: boolean;
}

function formatElapsed(s: number) {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function StatusDot({ state, isQa }: { state: AgentState | undefined; isQa: boolean }) {
  const status = state?.status ?? "pending";
  if (status === "pending")
    return <span className="w-4 h-4 rounded-full border-2 border-gray-200 dark:border-gray-700 shrink-0" />;
  if (status === "running")
    return <span className="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-gray-800 dark:border-t-gray-300 animate-spin shrink-0" />;
  if (isQa)
    return <span className={`w-4 h-4 rounded-full shrink-0 ${state?.passed ? "bg-green-500" : "bg-red-400"}`} />;
  return <span className="w-4 h-4 rounded-full bg-gray-900 dark:bg-white shrink-0" />;
}

function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

// Device type doesn't change at runtime, so useSyncExternalStore just needs a no-op subscribe.
function subscribeNoop(): () => void {
  return () => {};
}

export default function BuildClient({
  initialPrompt = "",
  treasury = "",
  rpcUrl = "",
}: {
  initialPrompt?: string;
  treasury?: string;
  rpcUrl?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [paying, setPaying] = useState(false);
  // A paid-but-not-yet-succeeded payment, so a failed build can retry without re-charging.
  const [paidSignature, setPaidSignature] = useState("");
  const [paidPayer, setPaidPayer] = useState("");
  const history = useSyncExternalStore(subscribeHistory, getHistorySnapshot, getHistoryServerSnapshot);
  const pendingPayment = useSyncExternalStore(subscribePendingPayment, getPendingPaymentSnapshot, getPendingPaymentServerSnapshot);
  const [restored, setRestored] = useState(false);
  // false on the server (no note during SSR), real value on the client — avoids a hydration mismatch.
  const isMobile = useSyncExternalStore(subscribeNoop, isMobileDevice, () => false);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Sync state when the user leaves native fullscreen (e.g. presses Esc).
    const handler = () => { if (!document.fullscreenElement) setIsFullscreen(false); };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const openBuild = useCallback((entry: HistoryEntry) => {
    setPrompt(entry.prompt);
    setHtml(entry.html);
    setAgentStates({});
    setError("");
    setElapsed(0);
    setRestored(true);
    setPhase("done");
  }, []);

  const toggleFullscreen = useCallback(() => {
    // Drive the state directly so the container fills the window via CSS
    // (fixed inset-0) even if the native Fullscreen API is unavailable/denied;
    // also request true OS fullscreen as a best-effort enhancement.
    const next = !isFullscreen;
    setIsFullscreen(next);
    try {
      if (next) void gameContainerRef.current?.requestFullscreen();
      else if (document.fullscreenElement) void document.exitFullscreen();
    } catch {
      // Native fullscreen denied — the fixed-position fallback still fills the window.
    }
  }, [isFullscreen]);

  const openInNewTab = useCallback(() => {
    // Render the game straight from the HTML we already hold in the browser, with
    // no dependency on server-side /play/<id> persistence. Use a Blob URL rather
    // than window.open("") + document.write: mobile Safari renders a BLACK screen
    // for the document.write approach (the about:blank document never parses/runs
    // the game), whereas a blob: URL is loaded as a normal document and the game's
    // scripts execute correctly on every browser.
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const w = window.open(url, "_blank");
    if (w) {
      // Keep the URL alive long enough for the new tab to load, then release it.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else {
      // In-app wallet browsers (Phantom's dApp browser, etc.) are WebViews that
      // often can't open a new tab at all — window.open returns null. Load the
      // game in the current view instead so the user never gets a black/blank
      // screen; their browser back button returns to the build (state persists).
      window.location.href = url;
    }
  }, [html]);

  useEffect(() => {
    if (phase === "building") {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(
        () => setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000)),
        1000,
      );
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  const startBuild = useCallback(async (paymentSignature: string, payer: string, promptOverride?: string) => {
    const effectivePrompt = (promptOverride ?? prompt).trim();
    if (!effectivePrompt) return;

    setAgentStates(Object.fromEntries(PIPELINE.map(a => [a.id, { status: "pending" as const, attempt: 1 }])));
    setHtml("");
    setError("");
    setElapsed(0);
    setRestored(false);
    setPhase("building");

    // 1 — Kick off the background build and get its id. The build runs server-
    // side independent of this request, so a dropped connection can't kill it.
    let buildId: string;
    try {
      const res = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: effectivePrompt, paymentSignature, payer }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `Request failed (${res.status})`);
        setPhase("error");
        return;
      }
      const data = await res.json().catch(() => ({})) as { buildId?: string };
      if (!data.buildId) {
        setError("Build could not be started. Please try again.");
        setPhase("error");
        return;
      }
      buildId = data.buildId;
    } catch {
      setError("Couldn't reach the server to start the build. Your payment is saved — use Resume to retry (you won't be charged again).");
      setPhase("error");
      return;
    }

    // 2 — Poll for progress. Each request is short, so an HTTP/2 reset can't kill
    // the build; a transient poll failure just retries on the next tick.
    const deadline = Date.now() + 12 * 60_000; // safety cap
    let consecutiveMisses = 0;
    let consecutiveUnknown = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      let job: {
        steps?: Record<string, AgentState>;
        done?: boolean;
        html?: string;
        error?: string;
        unknown?: boolean;
      };
      try {
        const res = await fetch(`/api/build/status/${buildId}`);
        if (!res.ok) {
          if (++consecutiveMisses > 60) break;
          continue;
        }
        job = await res.json();
        consecutiveMisses = 0;
      } catch {
        if (++consecutiveMisses > 60) break;
        continue;
      }

      // The server no longer knows this build AND nothing was saved — it means
      // the build process died (e.g. the server restarted mid-build). Detect it
      // fast and surface Resume instead of spinning until the 12-minute cap.
      if (job.unknown) {
        if (++consecutiveUnknown >= 4) {
          setError("The build was interrupted — the server restarted before it finished. Your payment is saved, so click Resume to continue (you won't be charged again).");
          setPhase("error");
          return;
        }
        continue;
      }
      consecutiveUnknown = 0;

      if (job.steps && Object.keys(job.steps).length > 0) {
        setAgentStates((prev) => ({ ...prev, ...job.steps }));
      }

      if (job.done) {
        if (job.error) {
          setError(job.error);
          setPhase("error");
          return;
        }
        const builtHtml = job.html ?? "";
        setHtml(builtHtml);
        setRestored(false);
        setPhase("done");
        // Build succeeded — the payment is consumed, so a fresh build pays again.
        setPaidSignature("");
        setPaidPayer("");
        setPendingPayment(null);
        pushHistory(effectivePrompt, builtHtml, buildId);
        return;
      }
    }

    setError("The build is taking longer than expected. Your payment is saved — use Resume to reconnect (you won't be charged again).");
    setPhase("error");
  }, [prompt]);

  const handlePayAndBuild = useCallback(async () => {
    if (!prompt.trim() || paying) return;
    // Already paid (a previous build failed)? Reuse that payment — don't re-charge.
    if (paidSignature) {
      void startBuild(paidSignature, paidPayer);
      return;
    }
    if (!rpcUrl || !treasury) {
      setError("Payments aren't configured yet. Please try again later.");
      setPhase("error");
      return;
    }
    setError("");
    setPaying(true);
    try {
      const { signature, payer } = await payForBuild({
        rpcUrl,
        treasury,
        usdcAmount: BUILD_PRICE_USDC,
      });
      setPaidSignature(signature);
      setPaidPayer(payer);
      // Persist so a refresh mid-build can resume this paid build, not lose it.
      setPendingPayment({ signature, payer, prompt: prompt.trim() });
      setPaying(false);
      void startBuild(signature, payer);
    } catch (err) {
      setPaying(false);
      const msg = err instanceof Error ? err.message : "Payment failed";
      if (msg === "PHANTOM_NOT_FOUND") {
        if (isMobileDevice()) {
          // Reopen this page inside Phantom's in-app browser, where the wallet
          // is injected. Carry the prompt through so it isn't lost.
          const target = `${window.location.origin}/build?p=${encodeURIComponent(prompt.trim())}`;
          window.location.href =
            `https://phantom.app/ul/browse/${encodeURIComponent(target)}?ref=${encodeURIComponent(window.location.origin)}`;
          return;
        }
        setError("Phantom wallet not found — install the Phantom extension to pay and generate.");
        setPhase("error");
        return;
      }
      if (msg.startsWith("INSUFFICIENT_USDC:")) {
        const have = msg.split(":")[1] ?? "0";
        setError(`Not enough USDC — this costs ${BUILD_PRICE_USDC} USDC, but your wallet only has ${have}. Add USDC and try again.`);
        setPhase("error");
        return;
      }
      if (msg === "INSUFFICIENT_SOL") {
        setError("Your wallet has no SOL to pay the Solana network fee. Add a little SOL (about 0.02) to your wallet and try again — USDC alone can't cover the fee.");
        setPhase("error");
        return;
      }
      if (msg === "PAYMENT_FAILED") {
        setError("Your payment transaction failed on-chain. Please check your wallet and try again.");
        setPhase("error");
        return;
      }
      // Declining the wallet prompt is a normal cancel, not an error to surface.
      if (/reject|cancel|denied/i.test(msg)) return;
      setError(msg);
      setPhase("error");
    }
  }, [prompt, paying, startBuild, rpcUrl, treasury, paidSignature, paidPayer]);

  const reset = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setPhase("idle");
    setPrompt("");
    setAgentStates({});
    setHtml("");
    setError("");
    setElapsed(0);
    setRestored(false);
    // Start over = a clean slate. Drop any saved payment so the next build pays
    // fresh (the escape hatch if a signature never landed). Resume reuses it.
    setPaidSignature("");
    setPaidPayer("");
    setPendingPayment(null);
  }, []);

  // ── Idle ──────────────────────────────────────────────────────────────────────
  if (phase === "idle") {
    return (
      <main className="max-w-2xl mx-auto px-6 pt-32 pb-24">
        <div style={{ animation: "fade-up 0.5s ease both" }}>
          <div className="mb-6">
            <span className="inline-flex items-center text-[11px] font-mono font-semibold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-full px-3 py-1 tracking-wider">
              AXON BUILD
            </span>
          </div>
          <h1 className="text-4xl sm:text-6xl font-bold text-gray-900 dark:text-white mb-4 tracking-tight leading-[1.05]">
            Build a playable game from one sentence.
          </h1>
          <p className="text-base sm:text-lg text-gray-500 dark:text-gray-400 mb-10 leading-relaxed">
            Describe your idea. Six AI agents design, code, art, and test a complete browser game — live, in a few minutes.
          </p>

          {pendingPayment && (
            <div className="mb-6 p-4 rounded-xl border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900">
              <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">You have a paid build that didn&apos;t finish</p>
              {pendingPayment.prompt && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 truncate">&ldquo;{pendingPayment.prompt}&rdquo;</p>
              )}
              <button
                onClick={() => {
                  setPrompt(pendingPayment.prompt);
                  void startBuild(pendingPayment.signature, pendingPayment.payer, pendingPayment.prompt);
                }}
                className="text-sm px-4 py-2 rounded-lg bg-[#0a0a0a] hover:bg-[#222] text-white dark:bg-white dark:text-[#0a0a0a] dark:hover:bg-gray-200 font-medium transition-colors"
              >
                Resume Build →
              </button>
            </div>
          )}

          {isMobile && (
            <div className="mb-5 text-[12px] text-amber-700 dark:text-amber-400/90 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-lg px-3 py-2">
              On mobile you can build and play, but for the best experience — smoother play, fullscreen, and open-in-new-tab — we recommend generating on a desktop or laptop.
            </div>
          )}

          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handlePayAndBuild(); }}
            placeholder="A top-down dungeon crawler where you collect keys to unlock doors and reach the exit..."
            maxLength={300}
            rows={4}
            className="w-full px-4 py-3 text-sm rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:border-gray-400 dark:focus:border-gray-500 focus:outline-none resize-none transition-colors placeholder:text-gray-300 dark:placeholder:text-gray-600 mb-1"
          />
          <div className="flex justify-end mb-5">
            <span className="text-[11px] font-mono text-gray-300 dark:text-gray-600">{prompt.length}/300</span>
          </div>

          {mentions3D(prompt) && (
            <div className="mb-5 text-[12px] text-amber-700 dark:text-amber-400/90 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-lg px-3 py-2">
              Heads up — Axon Build makes 2D games right now. 3D is coming soon. You&apos;ll get a polished 2D version of this idea.
            </div>
          )}

          <button
            onClick={() => void handlePayAndBuild()}
            disabled={!prompt.trim() || paying}
            className="w-full py-4 rounded-xl bg-[#0a0a0a] hover:bg-[#222] text-white dark:bg-white dark:text-[#0a0a0a] dark:hover:bg-gray-200 font-semibold text-base transition-colors disabled:opacity-30 disabled:cursor-not-allowed mb-2"
          >
            {paying
              ? "Confirm payment in your wallet…"
              : paidSignature
                ? "Retry Build →"
                : `Pay $${BUILD_PRICE_USDC} & Build →`}
          </button>
          <p className="text-[11px] text-center text-gray-400 dark:text-gray-500 mb-10">
            ${BUILD_PRICE_USDC} USDC per game · pay with Phantom on Solana
          </p>

          <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-3">Try an example</p>
          <div className="flex flex-col gap-2 mb-10">
            {EXAMPLES.map(ex => (
              <button
                key={ex}
                onClick={() => setPrompt(ex)}
                className="text-left text-[13px] leading-snug whitespace-normal break-words px-4 py-3 rounded-lg border border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>

          {history.length > 0 && (
            <>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-3">Recent builds</p>
              <div className="flex flex-col gap-2 mb-10">
                {history.map(entry => (
                  <button
                    key={entry.ts}
                    onClick={() => openBuild(entry)}
                    className="flex items-center justify-between gap-3 text-left text-xs px-3 py-2.5 rounded-lg border border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                  >
                    <span className="truncate">{entry.prompt}</span>
                    <span className="shrink-0 font-mono text-[10px] text-gray-300 dark:text-gray-600">↗</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <p className="text-[11px] font-mono text-gray-300 dark:text-gray-600">
            6 agents · ~5 min
          </p>
        </div>
      </main>
    );
  }

  // ── Building ──────────────────────────────────────────────────────────────────
  if (phase === "building") {
    return (
      <main className="max-w-2xl mx-auto px-6 pt-32 pb-24">
        <div style={{ animation: "fade-up 0.4s ease both" }}>
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-4">AXON BUILD</p>
          <div className="flex items-baseline gap-3 mb-8">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Building your game</h1>
            <span className="text-sm font-mono text-gray-400 dark:text-gray-500">{formatElapsed(elapsed)}</span>
          </div>

          <div className="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden mb-6">
            {PIPELINE.map((agent, i) => {
              const state = agentStates[agent.id];
              const status = state?.status ?? "pending";
              return (
                <div
                  key={agent.id}
                  className={`flex items-center gap-4 px-5 py-4 transition-colors ${i > 0 ? "border-t border-gray-50 dark:border-gray-800" : ""} ${status === "running" ? "bg-gray-50 dark:bg-gray-900/50" : ""}`}
                >
                  <StatusDot state={state} isQa={agent.id === "build-qa"} />
                  <span className={`text-sm font-medium w-24 shrink-0 ${status === "pending" ? "text-gray-300 dark:text-gray-600" : "text-gray-900 dark:text-white"}`}>
                    {agent.name}
                    {(state?.attempt ?? 1) > 1 && (
                      <span className="text-[10px] font-mono text-gray-400 ml-1.5">×{state!.attempt}</span>
                    )}
                  </span>
                  <span className={`text-sm flex-1 truncate ${status === "pending" ? "text-gray-200 dark:text-gray-700" : status === "running" ? "text-gray-600 dark:text-gray-300" : "text-gray-400 dark:text-gray-500"}`}>
                    {status === "running" ? `${agent.label}...` : agent.label}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="text-xs font-mono text-gray-400 dark:text-gray-500">
            {PIPELINE.filter(a => agentStates[a.id]?.status === "done").length} / {PIPELINE.length} agents complete
          </p>
        </div>
      </main>
    );
  }

  // ── Done ─────────────────────────────────────────────────────────────────────
  if (phase === "done") {
    const qaPassed = agentStates["build-qa"]?.passed ?? true;
    return (
      <main className="max-w-5xl mx-auto px-6 pt-24 pb-24">
        <div style={{ animation: "fade-up 0.4s ease both" }}>
          <div ref={gameContainerRef} className={`bg-black relative ${isFullscreen ? "fixed inset-0 z-50" : "mb-8 rounded-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"}`}>
            <iframe
              srcDoc={html}
              sandbox="allow-scripts"
              allow="autoplay; fullscreen"
              className="w-full block"
              style={{ height: isFullscreen ? "100%" : "600px" }}
              title="Your game"
            />
            <button
              onClick={() => void toggleFullscreen()}
              className="absolute top-3 right-3 p-2 rounded-lg bg-black/40 hover:bg-black/60 text-white/60 hover:text-white transition-colors"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <IconCompress /> : <IconExpand />}
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 mb-6">
            <div>
              <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-1">AXON BUILD</p>
              <p className="text-xs font-mono text-gray-400 dark:text-gray-500">
                {restored ? "Restored from history" : <>{formatElapsed(elapsed)}{!qaPassed && " · QA flagged issues"}</>}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={openInNewTab}
                className="text-sm px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                Open in new tab ↗
              </button>
              <a
                href={`data:text/html;charset=utf-8,${encodeURIComponent(html)}`}
                download={downloadFileName(prompt)}
                className="text-sm px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                Download
              </a>
              <button
                onClick={reset}
                className="text-sm px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                Build another →
              </button>
            </div>
          </div>

          {!restored && (
            <div className="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
              {PIPELINE.map((agent, i) => {
                const state = agentStates[agent.id];
                return (
                  <div key={agent.id} className={`flex items-center gap-4 px-5 py-3 ${i > 0 ? "border-t border-gray-50 dark:border-gray-800" : ""}`}>
                    <StatusDot state={state} isQa={agent.id === "build-qa"} />
                    <span className="text-sm font-medium w-24 shrink-0 text-gray-900 dark:text-white">
                      {agent.name}
                      {(state?.attempt ?? 1) > 1 && (
                        <span className="text-[10px] font-mono text-gray-400 ml-1.5">×{state!.attempt}</span>
                      )}
                    </span>
                    <span className="text-sm flex-1 text-gray-400 dark:text-gray-500 truncate">{agent.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────────
  return (
    <main className="max-w-2xl mx-auto px-6 pt-32 pb-24">
      <div style={{ animation: "fade-up 0.4s ease both" }}>
        <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-4">AXON BUILD</p>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">Build failed</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">{error}</p>
        <div className="flex flex-wrap gap-3">
          {pendingPayment && (
            <button
              onClick={() => void startBuild(pendingPayment.signature, pendingPayment.payer, pendingPayment.prompt)}
              className="px-4 py-2 rounded-lg bg-[#0a0a0a] hover:bg-[#222] text-white dark:bg-white dark:text-[#0a0a0a] dark:hover:bg-gray-200 text-sm font-medium transition-colors"
            >
              Resume Build →
            </button>
          )}
          <button
            onClick={reset}
            className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
          >
            Start over
          </button>
        </div>
      </div>
    </main>
  );
}
