"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import FadeIn from "@/components/FadeIn";

const JOURNEY = [
  { id: "caller",  short: "Caller"  },
  { id: "axon",    short: "Axon"    },
  { id: "payment", short: "Escrow"  },
  { id: "worker",  short: "Worker"  },
  { id: "ai",      short: "AI"      },
  { id: "target",  short: "Target"  },
  { id: "trace",   short: "Trace"   },
] as const;

type NodeId = typeof JOURNEY[number]["id"];

const NODE: Record<NodeId, { label: string; sub: string; addr: string }> = {
  caller:  { label: "Caller Agent",  sub: "initiates task",   addr: "agent://caller"   },
  axon:    { label: "Axon Protocol", sub: "hub",              addr: "axon://hub"       },
  payment: { label: "USDC Escrow",   sub: "x402 / MPP",      addr: "axon://escrow"    },
  worker:  { label: "Worker",        sub: "task executor",    addr: "axon://worker"    },
  ai:      { label: "AI Provider",   sub: "claude / gpt / grok / ollama",  addr: "provider://ai"    },
  target:  { label: "Target Agent",  sub: "receives result",  addr: "agent://target"   },
  trace:   { label: "Trace Log",     sub: "observability",    addr: "axon://trace"     },
};

const STEPS: { from: NodeId; to: NodeId; label: string; desc: string; payload: string }[] = [
  { from: "caller",  to: "axon",    label: "Task + Payment",  payload: "{ task, x402_header }",       desc: "The caller agent sends a task with an x402 or MPP payment header. This is the entry point — nothing happens until payment is attached." },
  { from: "axon",    to: "payment", label: "Escrow USDC",     payload: "{ amount, signature }",        desc: "Axon verifies the payment signature and locks the USDC in escrow on-chain. Funds are held — not yet released to anyone." },
  { from: "axon",    to: "worker",  label: "Queue Task",      payload: "{ task_id, trace_id }",        desc: "With payment confirmed, Axon assigns the task a unique trace ID and queues it for a worker to pick up." },
  { from: "worker",  to: "ai",      label: "Run Inference",   payload: "{ prompt, context }",          desc: "The worker forwards the task to the AI provider — Claude, OpenAI, or Ollama. Execution happens here." },
  { from: "ai",      to: "worker",  label: "Result Ready",    payload: "{ result, tokens_used }",      desc: "The AI provider completes the task and returns the result back to the worker, ready to be delivered." },
  { from: "axon",    to: "target",  label: "Deliver Result",  payload: "{ result, trace_id }",         desc: "The completed result is routed through Axon and delivered to the target agent. The caller gets their answer." },
  { from: "payment", to: "target",  label: "Release Payment", payload: "{ amount, receipt_hash }",     desc: "Only after successful delivery does Axon release the escrowed USDC to the target agent's wallet." },
  { from: "worker",  to: "trace",   label: "Log Trace",       payload: "{ task, timing, payment }",    desc: "Every detail — task content, timing, payment amount, and result — is written to the trace log. Fully queryable." },
];

const TRACE_IDS = [
  "req_a7f3c2d9", "txn_b4e89f1a", "tsk_c93d71e8",
  "job_d81a42f7", "res_e29b56c3", "dlv_f47c83b2",
  "pmt_g15d94e8", "log_h72e25f4",
];

const ACCENT     = "rgba(255,255,255,0.9)";
const ACCENT_DIM = "rgba(255,255,255,0.1)";
const ACCENT_BG  = "rgba(255,255,255,0.04)";
const ACCENT_GLW = "0 0 20px 4px rgba(255,255,255,0.06)";

const STEP_MS = 3000;

function NodeCard({
  role, nodeId, animKey,
}: {
  role: "from" | "to";
  nodeId: NodeId;
  animKey: string;
}) {
  const node = NODE[nodeId];
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={animKey}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        transition={{ duration: 0.28 }}
        className="flex-1 rounded-xl p-3 sm:p-4 md:p-6 flex flex-col gap-3 sm:gap-4 relative overflow-hidden"
        style={{
          background: ACCENT_BG,
          border: `1px solid ${ACCENT_DIM}`,
          boxShadow: ACCENT_GLW,
        }}
      >
        {/* Subtle corner glow */}
        <div
          className="absolute -top-8 -right-8 w-24 h-24 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%)" }}
        />

        {/* Role label + addr */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-widest text-white/40">
            {role === "from" ? "← From" : "To →"}
          </span>
          <span className="text-[9px] font-mono text-white/20 hidden sm:block">{node.addr}</span>
        </div>

        {/* Node name */}
        <div>
          <p className="text-sm sm:text-xl md:text-2xl lg:text-3xl font-bold text-white leading-tight tracking-tight">
            {node.label}
          </p>
          <p className="text-xs font-mono mt-1 text-white/35">
            {node.sub}
          </p>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2">
          <motion.span
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.6, repeat: Infinity }}
            className="w-1.5 h-1.5 rounded-full bg-green-500"
          />
          <span className="text-[10px] font-mono text-white/35">
            ACTIVE
          </span>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export default function HowItWorksPage() {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setActive(s => (s + 1) % STEPS.length), STEP_MS);
    return () => clearTimeout(t);
  }, [active, playing]);

  const step = STEPS[active];

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />

      <div className="pt-28 pb-24 px-6">
        <div className="max-w-5xl mx-auto">

          {/* Header */}
          <FadeIn>
            <div className="text-center mb-14">
              <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">PROTOCOL FLOW</p>
              <h1 className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white mb-4 tracking-tight">
                How Axon works.
              </h1>
              <p className="text-gray-500 dark:text-gray-400 max-w-xl mx-auto text-lg leading-relaxed">
                Every agent call follows the same path — discovery, payment, execution, settlement, and trace.
              </p>
            </div>
          </FadeIn>

          {/* Main panel */}
          <FadeIn delay={200}>
            <div
              className="rounded-2xl p-px mb-4"
              style={{ background: `linear-gradient(135deg, ${ACCENT_DIM} 0%, rgba(255,255,255,0.04) 100%)` }}
            >
              <div className="rounded-2xl overflow-hidden" style={{ background: "#07080c" }}>

                {/* Panel header */}
                <div
                  className="flex items-center justify-between px-6 pt-5 pb-4 border-b"
                  style={{ borderColor: "rgba(255,255,255,0.05)" }}
                >
                  <div className="flex items-center gap-4">
                    {/* Live badge */}
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono text-white/50 border border-white/10 bg-white/[0.04]">
                      <motion.span
                        animate={{ opacity: [1, 0.3, 1] }}
                        transition={{ duration: 1.4, repeat: Infinity }}
                        className="w-1.5 h-1.5 rounded-full bg-green-500"
                      />
                      LIVE
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-white/25">
                        {String(active + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
                      </span>
                      <AnimatePresence mode="wait">
                        <motion.span
                          key={active}
                          initial={{ opacity: 0, x: 6 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -6 }}
                          transition={{ duration: 0.2 }}
                          className="text-sm font-semibold text-white"
                        >
                          {step.label}
                        </motion.span>
                      </AnimatePresence>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="hidden sm:block text-[10px] font-mono text-white/20">
                      {TRACE_IDS[active]}
                    </span>
                    <button
                      onClick={() => setPlaying(p => !p)}
                      className="text-[10px] font-mono text-white/25 hover:text-white/60 transition-colors tracking-wider"
                    >
                      {playing ? "PAUSE" : "PLAY"}
                    </button>
                  </div>
                </div>

                {/* Journey mini-map */}
                <div
                  className="px-6 py-4 border-b"
                  style={{ borderColor: "rgba(255,255,255,0.04)" }}
                >
                  <div className="flex items-center">
                    {JOURNEY.map((node, i) => {
                      const isActive = step.from === node.id || step.to === node.id;
                      return (
                        <div key={node.id} className="flex items-center flex-1 last:flex-none">
                          <div className="flex flex-col items-center gap-1.5">
                            <motion.div
                              animate={{
                                width:      isActive ? 10 : 6,
                                height:     isActive ? 10 : 6,
                                background: isActive ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.12)",
                                boxShadow:  isActive ? "0 0 8px 3px rgba(255,255,255,0.25)" : "none",
                              }}
                              transition={{ duration: 0.3 }}
                              className="rounded-full"
                            />
                            <span
                              className="text-[9px] font-mono transition-all duration-300 whitespace-nowrap hidden sm:block"
                              style={{ color: isActive ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.18)" }}
                            >
                              {node.short}
                            </span>
                          </div>
                          {i < JOURNEY.length - 1 && (
                            <div
                              className="flex-1 h-px mx-1.5"
                              style={{ background: "rgba(255,255,255,0.06)" }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Step detail */}
                <div className="px-3 sm:px-6 md:px-10 py-6 sm:py-8 md:py-12">
                  <div className="flex items-stretch gap-2 sm:gap-4 md:gap-6">

                    {/* FROM card */}
                    <NodeCard role="from" nodeId={step.from} animKey={`from-${active}`} />

                    {/* Arrow + payload */}
                    <div className="flex-shrink-0 flex flex-col items-center justify-center gap-2 w-10 sm:w-20 md:w-28">
                      <svg viewBox="0 0 112 32" width="100%" height="32" style={{ overflow: "visible" }}>
                        <defs>
                          <filter id="dot-glow" x="-200%" y="-200%" width="500%" height="500%">
                            <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
                          </filter>
                        </defs>
                        {/* Track */}
                        <line
                          x1={0} y1={16} x2={100} y2={16}
                          stroke={ACCENT} strokeOpacity={0.2} strokeWidth={1}
                        />
                        {/* Arrowhead */}
                        <path
                          d="M98,11 L108,16 L98,21 z"
                          fill={ACCENT} fillOpacity={0.55}
                        />
                        {/* Halo */}
                        <motion.circle
                          key={`ahalo-${active}`}
                          initial={{ cx: 0, cy: 16, opacity: 0 }}
                          animate={{ cx: [0, 54, 100], cy: 16, opacity: [0, 0.25, 0] }}
                          transition={{ duration: 2, ease: "easeInOut" }}
                          r={13} fill={ACCENT} filter="url(#dot-glow)"
                        />
                        {/* Core dot */}
                        <motion.circle
                          key={`adot-${active}`}
                          initial={{ cx: 0, cy: 16, opacity: 0 }}
                          animate={{ cx: [0, 54, 100], cy: 16, opacity: [0, 1, 0] }}
                          transition={{ duration: 2, ease: "easeInOut" }}
                          r={4.5} fill={ACCENT}
                        />
                      </svg>

                      {/* Payload chip */}
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={active}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          transition={{ duration: 0.25 }}
                          className="hidden sm:block rounded-md px-2 py-1 text-center bg-white/[0.04] border border-white/[0.08]"
                        >
                          <p className="text-[8px] font-mono leading-relaxed text-white/40">
                            {step.payload}
                          </p>
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    {/* TO card */}
                    <NodeCard role="to" nodeId={step.to} animKey={`to-${active}`} />
                  </div>
                </div>

                {/* Description + progress */}
                <div
                  className="px-6 pb-6 pt-5 border-t"
                  style={{ borderColor: "rgba(255,255,255,0.05)" }}
                >
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={active}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      transition={{ duration: 0.25 }}
                      className="text-sm text-white/35 text-center leading-relaxed mb-5 max-w-xl mx-auto"
                    >
                      {step.desc}
                    </motion.p>
                  </AnimatePresence>

                  {/* Progress pills */}
                  <div className="flex items-center justify-center gap-1.5">
                    {STEPS.map((_, i) => (
                      <button key={i} onClick={() => { setActive(i); setPlaying(false); }}>
                        <motion.span
                          animate={{
                            width:      active === i ? 22 : 5,
                            background: active === i ? ACCENT : "rgba(255,255,255,0.15)",
                          }}
                          transition={{ duration: 0.25 }}
                          className="block h-1.5 rounded-full"
                        />
                      </button>
                    ))}
                  </div>
                </div>

              </div>
            </div>
          </FadeIn>

          {/* Step selector */}
          <FadeIn delay={350}>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 mb-16">
              {STEPS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => { setActive(i); setPlaying(false); }}
                  className={`text-left px-3 py-3 rounded-xl border transition-all duration-200 ${
                    active === i
                      ? "border-gray-900 bg-gray-900 text-white dark:border-gray-600 dark:bg-gray-800"
                      : "border-gray-200 bg-white hover:border-gray-300 text-gray-500 hover:text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700 dark:text-gray-400 dark:hover:text-white"
                  }`}
                >
                  <span className={`text-[10px] font-mono block mb-1 ${active === i ? "text-white/40" : "text-gray-300 dark:text-gray-600"}`}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-xs font-medium leading-snug">{s.label}</span>
                </button>
              ))}
            </div>
          </FadeIn>

          {/* Breakdown */}
          <FadeIn delay={450}>
            <div className="grid md:grid-cols-2 gap-4 mb-16">
              {STEPS.map((s, i) => (
                <div
                  key={i}
                  onClick={() => { setActive(i); setPlaying(false); }}
                  className={`p-5 rounded-xl border transition-colors duration-200 cursor-pointer ${
                    active === i
                      ? "border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
                      : "border-gray-100 bg-white hover:border-gray-200 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-mono text-gray-300 dark:text-gray-600">{String(i + 1).padStart(2, "0")}</span>
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">{s.label}</span>
                  </div>
                  <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{s.desc}</p>
                </div>
              ))}
            </div>
          </FadeIn>

          {/* CTA */}
          <FadeIn delay={500}>
            <div className="text-center">
              <div className="inline-flex items-center gap-6">
                <Link href="/docs" className="px-6 py-3 bg-[#0a0a0a] hover:bg-[#222] text-white rounded-lg text-sm font-medium transition-colors">
                  Read the docs
                </Link>
                <Link href="/agents" className="text-sm font-medium text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                  Browse agents →
                </Link>
              </div>
            </div>
          </FadeIn>
        </div>
      </div>

      <footer className="border-t border-gray-200 dark:border-gray-800 py-12 px-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <span className="text-sm font-semibold tracking-[0.2em] text-gray-400 dark:text-gray-500 uppercase">AXON</span>
          <p className="text-sm text-gray-400 dark:text-gray-500">Open source infrastructure for agent-to-agent work.</p>
          <div className="flex gap-6">
            <Link href="https://github.com/SeierkDev/Axon" target="_blank" className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors">GitHub</Link>
            <Link href="/docs" className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors">Docs</Link>
            <Link href="/litepaper" className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors">Litepaper</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
