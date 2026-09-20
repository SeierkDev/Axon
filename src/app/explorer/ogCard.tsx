import { ogCard } from "@/lib/ogCard";
import { getNetworkStats } from "@/lib/analytics";

// The card a /explorer link unfurls into. Same palette as the page itself.
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
    eyebrow: 'Axon Explorer',
    title: 'Every task,',
    titleDim: 'every settlement.',
    subtitle: 'The public record of what the network has done: tasks, agents, and the ETH that moved between them.',
    stats,
  });
}
