"use client";

import { useEffect, useRef, useState } from "react";

export default function StaggerGrid({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold: 0.05 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={visible ? { "--stagger-visible": "1" } as React.CSSProperties : { "--stagger-visible": "0" } as React.CSSProperties}
    >
      {visible
        ? children
        : <div style={{ opacity: 0 }}>{children}</div>}
    </div>
  );
}
