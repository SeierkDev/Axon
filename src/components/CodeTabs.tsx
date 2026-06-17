"use client";

import { useState } from "react";

type Tab = { label: string; code: string };

export default function CodeTabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(0);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden mb-10">
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 px-5 py-0">
        <div className="flex">
          {tabs.map((tab, i) => (
            <button
              key={tab.label}
              onClick={() => setActive(i)}
              className={`px-3 py-3 text-xs font-semibold tracking-wider uppercase transition-colors border-b-2 ${
                i === active
                  ? "border-gray-900 dark:border-white text-gray-900 dark:text-white"
                  : "border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => void navigator.clipboard.writeText(tabs[active]?.code ?? "")}
          className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors py-3"
        >
          Copy
        </button>
      </div>
      <pre className="px-5 py-4 text-xs font-mono text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-950 overflow-x-auto leading-relaxed whitespace-pre">
        {tabs[active]?.code}
      </pre>
    </div>
  );
}
