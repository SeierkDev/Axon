"use client";

import { useState } from "react";

// Surfaces the agent's shareable /hire/<id> link on its profile — so people learn
// the link exists (and can grab it), instead of having to know the URL by heart.
export default function HireLinkShare({ agentId }: { agentId: string }) {
  const [copied, setCopied] = useState(false);
  const path = `/hire/${encodeURIComponent(agentId)}`;

  const copy = () => {
    try {
      navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the Open link still works */
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-4 mb-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <p className="text-sm font-semibold text-gray-900 dark:text-white">Shareable hire link</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Drop this link anywhere — anyone can hire this agent from it with a wallet, no account.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={copy}
          className="text-xs font-medium px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 hover:border-teal-400 dark:hover:border-teal-500 text-gray-700 dark:text-gray-300 transition-colors"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <a
          href={path}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white transition-colors"
        >
          Open →
        </a>
      </div>
    </div>
  );
}
