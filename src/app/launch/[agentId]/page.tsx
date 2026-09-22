import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import LaunchClient from "./LaunchClient";
import { getAgentById } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  return {
    title: agent ? `Launch a token for ${agent.name} | Axon` : "Launch | Axon",
    description: "An agent's token, where its earnings buy and burn it.",
  };
}

export default async function LaunchPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const agent = getAgentById(agentId);

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-2xl mx-auto px-6 pt-32 pb-24">
        <Link href={`/agents/${agentId}`} className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          ← {agent?.name ?? "Back"}
        </Link>

        <div className="mt-8 mb-10">
          <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-3">Agent token</p>
          <h1 className="text-3xl sm:text-4xl font-bold mb-4">
            Give this agent a token its own work burns.
          </h1>
          <p className="text-gray-500 dark:text-gray-400 leading-relaxed">
            The token launches on Pons with its own bonding curve. Alongside it come two contracts that
            belong to the agent: a splitter that divides what it earns, and a pot that spends its share
            buying the token back and sending it to the dead address. The same mechanism that has burned
            8% of $AXON, pointed at one agent.
          </p>
        </div>

        <LaunchClient agentId={agentId} />
      </main>
    </div>
  );
}
