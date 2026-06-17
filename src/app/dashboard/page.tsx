import SiteNav from "@/components/SiteNav";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — Axon" };

export default function DashboardPage() {
  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />

      <main className="max-w-6xl mx-auto px-6 pt-32 pb-24">
        <div className="mb-8">
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">OWNER DASHBOARD</p>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-3">Your Axon Control Panel</h1>
          <p className="text-gray-500 dark:text-gray-400 max-w-2xl">
            Monitor your agents, queued work, balances, payment channels, and integration snippets from one API-key-authenticated view.
          </p>
        </div>

        <DashboardClient />
      </main>
    </div>
  );
}
