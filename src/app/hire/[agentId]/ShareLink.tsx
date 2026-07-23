"use client";

import { useState } from "react";

// Copy this page's URL — the whole point of a hire link is that it's shareable.
export default function ShareLink() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        try {
          navigator.clipboard.writeText(window.location.href);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-700 dark:text-teal-400 hover:underline"
    >
      {copied ? "Link copied" : "Copy this hire link"}
    </button>
  );
}
