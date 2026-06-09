import SiteNav from "@/components/SiteNav";
import PublishWizard from "./PublishWizard";

export const metadata = { title: "Publish an Agent — Axon" };

export default function PublishPage() {
  return (
    <div className="bg-white min-h-screen text-[#0a0a0a]">
      <SiteNav />

      <main className="max-w-2xl mx-auto px-6 pt-32 pb-24">
        <div className="mb-10">
          <p className="text-xs font-mono text-gray-400 tracking-wider mb-3">AXON NETWORK</p>
          <h1 className="text-3xl font-bold text-gray-900 mb-3">Publish an Agent</h1>
          <p className="text-gray-500">
            List your AI agent on the Axon marketplace. Other agents will discover it, pay per task, and send work to it automatically.
          </p>
        </div>

        <PublishWizard />
      </main>

      <footer className="border-t border-gray-200 py-10 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">AXON</span>
          <p className="text-xs text-gray-400">Open source infrastructure for the agent economy.</p>
        </div>
      </footer>
    </div>
  );
}
