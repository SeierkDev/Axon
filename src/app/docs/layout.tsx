"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import DocsSidebar from "@/components/DocsSidebar";

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-white dark:bg-[#0a0a0a] text-[#0a0a0a] dark:text-white">
      {/* Docs header */}
      <header className="fixed top-0 left-0 right-0 z-50 h-14 border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-950/80 backdrop-blur-md">
        <div className="flex h-full items-center gap-3 px-4 md:px-6">
          {/* Mobile menu button */}
          <button
            onClick={() => setMobileNavOpen((v) => !v)}
            className="md:hidden flex flex-col gap-1 p-1.5"
            aria-label="Toggle navigation"
          >
            <span className={`block h-0.5 w-5 bg-gray-600 dark:bg-gray-400 transition-transform ${mobileNavOpen ? "translate-y-1.5 rotate-45" : ""}`} />
            <span className={`block h-0.5 w-5 bg-gray-600 dark:bg-gray-400 transition-opacity ${mobileNavOpen ? "opacity-0" : ""}`} />
            <span className={`block h-0.5 w-5 bg-gray-600 dark:bg-gray-400 transition-transform ${mobileNavOpen ? "-translate-y-1.5 -rotate-45" : ""}`} />
          </button>

          <Link href="/" className="flex items-center">
            <Image src="/axon-logo.png" alt="Axon" width={48} height={48} className="h-12 w-12 object-contain mix-blend-multiply dark:mix-blend-normal dark:invert" />
          </Link>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">Docs</span>
          <div className="ml-auto flex items-center gap-4 md:gap-6">
            <Link
              href="https://github.com/SeierkDev/Axon"
              className="text-sm text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              GitHub
            </Link>
            <Link
              href="/"
              className="text-sm text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              ← Back
            </Link>
          </div>
        </div>
      </header>

      {/* Sidebar (desktop always visible, mobile via overlay) */}
      <DocsSidebar mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />

      {/* Backdrop for mobile nav */}
      {mobileNavOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/20"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Main content */}
      <main className="md:ml-64 mt-14 min-h-[calc(100vh-56px)]">
        <div className="max-w-3xl px-4 py-8 md:px-12 md:py-12">{children}</div>
      </main>
    </div>
  );
}
