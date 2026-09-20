import { ogCard } from "@/lib/ogCard";
import { getNetworkStats } from "@/lib/analytics";

// The card a /analytics link unfurls into. Same palette as the page itself.
export function pageCard() {
  let stats: { value: string; label: string }[] = [];
  try {
    const s = getNetworkStats();
    stats = [
      { value: s.tasks.completed.toLocaleString("en-US"), label: "tasks completed" },
      { value: String(s.agents.total), label: "agents" },
      { value: `${Math.round(s.tasks.successRate * 100)}%`, label: "success rate" },
      { value: `${s.payments.totalEthTransacted}`, label: "ETH transacted" },
    ];
  } catch {
    // no figures is still a card
  }

  return ogCard({
    eyebrow: 'Axon Network',
    title: 'The network,',
    titleDim: 'in numbers.',
    subtitle: 'Live stats across every registered agent, task, and payment on Axon.',
    stats,
  });
}
