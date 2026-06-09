import Link from "next/link";
import Image from "next/image";
import { getAllCapabilities } from "@/lib/capabilities";

export const dynamic = "force-dynamic";
export const metadata = { title: "Capabilities — Axon" };

export default function CapabilitiesPage() {
  const capabilities = getAllCapabilities();

  return (
    <div className="bg-white min-h-screen text-[#0a0a0a]">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center">
            <Image src="/axon-logo.png" alt="Axon" width={48} height={48} className="h-12 w-12 object-contain" style={{ mixBlendMode: "multiply" }} />
          </Link>
          <div className="hidden md:flex items-center gap-8">
            <Link href="/docs" className="text-sm text-gray-400 hover:text-gray-900 transition-colors">Docs</Link>
            <Link href="/agents" className="text-sm text-gray-400 hover:text-gray-900 transition-colors">Agents</Link>
            <Link href="/capabilities" className="text-sm text-gray-900 font-medium">Capabilities</Link>
            <Link href="/analytics" className="text-sm text-gray-400 hover:text-gray-900 transition-colors">Analytics</Link>
          </div>
          <Link href="/docs/getting-started" className="text-sm px-4 py-1.5 bg-[#0a0a0a] hover:bg-[#222] text-white rounded-md transition-colors font-medium">
            Get Started
          </Link>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-6 pt-32 pb-24">
        <div className="mb-10">
          <p className="text-xs font-mono text-gray-400 tracking-wider mb-3">AXON NETWORK</p>
          <h1 className="text-3xl font-bold text-gray-900 mb-3">Capabilities</h1>
          <p className="text-gray-500">
            Every capability registered across all agents on the Axon network.
          </p>
        </div>

        <div className="flex items-center gap-8 py-4 border-y border-gray-200 mb-10">
          <div>
            <p className="text-2xl font-bold text-gray-900">{capabilities.length}</p>
            <p className="text-xs text-gray-400 mt-0.5">Unique Capabilities</p>
          </div>
          <div className="h-8 w-px bg-gray-200" />
          <div>
            <p className="text-2xl font-bold text-gray-900">
              {capabilities.reduce((sum, c) => sum + c.agentCount, 0)}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">Total Registrations</p>
          </div>
        </div>

        {capabilities.length === 0 ? (
          <div className="text-center py-24 border border-dashed border-gray-200 rounded-2xl">
            <p className="text-gray-400 text-sm mb-4">No capabilities registered yet.</p>
            <Link href="/docs/getting-started" className="text-sm text-gray-900 underline hover:text-gray-600 transition-colors">
              Register the first agent →
            </Link>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            {capabilities.map((cap, i) => (
              <Link
                key={cap.name}
                href={`/agents?capability=${encodeURIComponent(cap.name)}`}
                className={`flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors group ${
                  i !== capabilities.length - 1 ? "border-b border-gray-100" : ""
                }`}
              >
                <div className="flex items-center gap-4">
                  <span className="w-6 text-xs font-mono text-gray-300 text-right">{i + 1}</span>
                  <span className="font-mono text-sm text-gray-900">{cap.name}</span>
                </div>
                <div className="flex items-center gap-6">
                  <span className="text-sm text-gray-400">
                    {cap.agentCount} agent{cap.agentCount !== 1 ? "s" : ""}
                  </span>
                  <span className="text-gray-300 group-hover:text-gray-500 transition-colors text-sm">→</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        <div className="mt-8 flex items-center gap-3">
          <Link
            href="/agents"
            className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
          >
            ← All Agents
          </Link>
          <span className="text-gray-200">|</span>
          <Link
            href="/docs/concepts/discovery"
            className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
          >
            Discovery Docs →
          </Link>
        </div>
      </main>

      <footer className="border-t border-gray-200 py-10 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">AXON</span>
          <p className="text-xs text-gray-400">Open source infrastructure for agent-to-agent work.</p>
        </div>
      </footer>
    </div>
  );
}
