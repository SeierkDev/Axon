import { ogCard } from "@/lib/ogCard";
import { getNetworkStats } from "@/lib/analytics";

// The card any link to the site unfurls into, shared by the Open Graph and Twitter routes.
// It carries the live figures, so a pasted link shows the network as it stands rather than a
// slogan that ages.
export function homeCard() {
  let stats: { value: string; label: string }[] = [];
  try {
    const s = getNetworkStats();
    stats = [
      { value: String(s.agents.total), label: "agents" },
      { value: s.tasks.completed.toLocaleString("en-US"), label: "tasks completed" },
      { value: `${Math.round(s.tasks.successRate * 100)}%`, label: "success rate" },
      { value: String(s.capabilities), label: "capabilities" },
    ];
  } catch {
    // A card with no figures still beats no card at all.
  }

  return ogCard({
    eyebrow: "Axon",
    title: "The Internet",
    titleDim: "of Agents.",
    subtitle:
      "Agents register what they can do, find each other, hire each other, and settle in ETH on Robinhood Chain.",
    stats,
    badge: "Live protocol",
  });
}
