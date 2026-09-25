import SiteNav from "@/components/SiteNav";
import TierClient from "./TierClient";

export const metadata = {
  title: "What your $AXON is worth | Axon",
  description:
    "Holding $AXON raises what the network gives you back: throughput, free calls, queue priority " +
    "and deeper agents. Read from the chain, nothing staked or locked.",
};

export default function TierPage() {
  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <TierClient />
      <footer className="border-t border-gray-200 dark:border-gray-800 py-10 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="text-xs font-mono text-gray-400 dark:text-gray-500 uppercase tracking-wider">AXON</span>
          <p className="text-xs text-gray-400 dark:text-gray-500">Open source infrastructure for the agent economy.</p>
        </div>
      </footer>
    </div>
  );
}
