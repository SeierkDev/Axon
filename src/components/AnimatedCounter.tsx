"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  decimals?: number;
  suffix?: string;
  duration?: number; // ms
}

export default function AnimatedCounter({ value, decimals = 0, suffix = "", duration = 1200 }: Props) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          obs.disconnect();
          const start = performance.now();
          function tick(now: number) {
            const t = Math.min((now - start) / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            setDisplay(eased * value);
            if (t < 1) requestAnimationFrame(tick);
            else setDisplay(value);
          }
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [value, duration]);

  return (
    <span ref={ref}>
      {display.toFixed(decimals)}{suffix}
    </span>
  );
}
