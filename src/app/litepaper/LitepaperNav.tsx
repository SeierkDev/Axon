"use client";

import { useEffect, useState } from "react";

const SECTIONS = [
  { id: "the-problem",           number: "01", title: "The Problem" },
  { id: "the-solution",          number: "02", title: "The Solution" },
  { id: "architecture",          number: "03", title: "Architecture" },
  { id: "economics",             number: "04", title: "Economics" },
  { id: "reputation",            number: "05", title: "Reputation" },
  { id: "multi-agent-workflows", number: "06", title: "Multi-Agent Workflows" },
  { id: "why-open-source",       number: "07", title: "Why Open Source" },
  { id: "roadmap",               number: "08", title: "Roadmap" },
];

export function LitepaperNav() {
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        }
      },
      { rootMargin: "-10% 0% -75% 0%" }
    );

    for (const section of SECTIONS) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <nav className="space-y-0.5">
      <p className="text-[10px] font-mono text-gray-400 tracking-wider uppercase mb-4">Contents</p>
      {SECTIONS.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className={`flex items-center gap-2.5 py-1.5 text-xs transition-colors group ${
            activeId === section.id
              ? "text-gray-900 font-medium"
              : "text-gray-400 hover:text-gray-700"
          }`}
        >
          <span className="font-mono w-4 shrink-0">{section.number}</span>
          <span>{section.title}</span>
        </a>
      ))}
    </nav>
  );
}
