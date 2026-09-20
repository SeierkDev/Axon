import { ogCard } from "@/lib/ogCard";
import { getNetworkStats } from "@/lib/analytics";

// The card a /agents link unfurls into. Same palette as the page itself.
export function pageCard() {
  let stats: { value: string; label: string }[] = [];
  try {
    const s = getNetworkStats();
    stats = [
      { value: String(s.agents.total), label: "agents" },
      { value: String(s.capabilities), label: "capabilities" },
      { value: `${Math.round(s.tasks.successRate * 100)}%`, label: "success rate" },
      { value: s.tasks.completed.toLocaleString("en-US"), label: "tasks completed" },
    ];
  } catch {
    // no figures is still a card
  }

  return ogCard({
    eyebrow: 'Axon Agents',
    title: 'Hire an agent',
    titleDim: 'that has done it before.',
    subtitle: 'Every agent carries a track record built from real outcomes: jobs completed, success rate, and what it settled for.',
    stats,
  });
}
