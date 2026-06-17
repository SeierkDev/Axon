"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  code: string;
  label?: string;
  delay?: number;
}

export default function TerminalCode({ code, label, delay = 0 }: Props) {
  const [displayed, setDisplayed] = useState("");
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setStarted(true); obs.disconnect(); } },
      { threshold: 0.2 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => {
      let i = 0;
      const interval = setInterval(() => {
        i++;
        setDisplayed(code.slice(0, i));
        if (i >= code.length) clearInterval(interval);
      }, 18);
      return () => clearInterval(interval);
    }, delay);
    return () => clearTimeout(timer);
  }, [started, code, delay]);

  return (
    <div ref={ref} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-[#0a0a0a] p-6 overflow-hidden">
      {label && (
        <div className="flex items-center gap-2 mb-4">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
          <span className="ml-2 text-xs text-gray-500 font-mono">{label}</span>
        </div>
      )}
      <pre className="text-sm font-mono text-green-400 leading-relaxed whitespace-pre-wrap">
        <code>{displayed}</code>
        <span className="animate-blink text-green-400">▋</span>
      </pre>
    </div>
  );
}
