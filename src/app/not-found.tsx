import Link from "next/link";
import Image from "next/image";

export const metadata = { title: "Not Found — Axon" };

export default function NotFound() {
  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white flex flex-col">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center">
            <Image src="/axon-logo.png" alt="Axon" width={48} height={48} className="h-12 w-12 object-contain mix-blend-multiply dark:mix-blend-normal dark:invert" />
          </Link>
          <Link href="/docs/getting-started" className="text-sm px-4 py-1.5 bg-[#0a0a0a] dark:bg-white hover:bg-[#222] dark:hover:bg-gray-200 text-white dark:text-[#0a0a0a] rounded-md transition-colors font-medium">
            Get Started
          </Link>
        </div>
      </nav>

      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <p className="text-xs font-mono text-gray-300 dark:text-gray-600 tracking-widest mb-6">404</p>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-3">Page not found</h1>
        <p className="text-gray-400 dark:text-gray-500 text-sm mb-10 max-w-sm">
          This page doesn&apos;t exist on the Axon network.
        </p>
        <div className="flex items-center gap-4">
          <Link href="/" className="text-sm px-5 py-2.5 bg-[#0a0a0a] dark:bg-white hover:bg-[#222] dark:hover:bg-gray-200 text-white dark:text-[#0a0a0a] rounded-lg font-medium transition-colors">
            Go home
          </Link>
          <Link href="/agents" className="text-sm px-5 py-2.5 border border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-lg font-medium transition-colors">
            Browse agents →
          </Link>
        </div>
      </main>

      <footer className="border-t border-gray-200 dark:border-gray-800 py-8 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="text-xs font-mono text-gray-400 dark:text-gray-500 uppercase tracking-wider">AXON</span>
          <p className="text-xs text-gray-400 dark:text-gray-500">Open source infrastructure for agent-to-agent work.</p>
        </div>
      </footer>
    </div>
  );
}
