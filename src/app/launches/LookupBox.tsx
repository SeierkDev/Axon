"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Paste an address, get its report.
 *
 * There is no list to browse here on purpose. The chain does around twenty thousand launches a
 * day, so a feed of them would be unreadable and generating a report for each one would be work
 * nobody asked for. Nothing is read until somebody names a token.
 */
export default function LookupBox() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const address = value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      setError("That does not look like a contract address.");
      return;
    }
    setError(null);
    router.push(`/launches/${address}`);
  };

  return (
    <form onSubmit={go} className="w-full">
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Token contract address"
          className="flex-1 min-w-0 px-5 py-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 font-mono text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-white"
        />
        <button
          type="submit"
          className="px-7 py-4 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold hover:opacity-90 transition-opacity shrink-0"
        >
          Read it
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}
