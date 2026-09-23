import { ogCard } from "@/lib/ogCard";
import { getNetworkStats } from "@/lib/analytics";

/**
 * The figures the card shows, read once.
 *
 * Shared with the fingerprint below so the two cannot drift: anything that changes what the card
 * says must change what the fingerprint says, and the only way to guarantee that is to read the
 * same thing.
 */
function homeCardStats(): { value: string; label: string }[] {
  try {
    const s = getNetworkStats();
    return [
      { value: String(s.agents.total), label: "agents" },
      { value: s.tasks.completed.toLocaleString("en-US"), label: "tasks completed" },
      { value: `${Math.round(s.tasks.successRate * 100)}%`, label: "success rate" },
      { value: String(s.capabilities), label: "capabilities" },
    ];
  } catch {
    // A card with no figures still beats no card at all.
    return [];
  }
}

/**
 * A short string that changes whenever the card would look different.
 *
 * This exists because the card was live and nobody ever saw it change. Next.js gives the image a
 * URL ending in a hash of the route's source file, so it stays the same until that file is edited.
 * Telegram and X cache a preview against the URL they were handed, which froze the figures at
 * whatever they were when the file last changed, while the route underneath went on serving fresh
 * numbers that nothing ever requested.
 *
 * In the URL, a new set of figures is a new URL, and a new URL is a fetch nobody has cached.
 * Unchanged figures keep their URL and stay cached, which is the part worth keeping.
 */
export function homeCardFingerprint(): string {
  const text = homeCardStats().map((s) => `${s.label}=${s.value}`).join("|");
  // Not cryptographic and does not need to be. It has one job: differ when the input differs.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// The card any link to the site unfurls into, shared by the Open Graph and Twitter routes.
// It carries the live figures, so a pasted link shows the network as it stands rather than a
// slogan that ages.
export function homeCard() {
  const stats = homeCardStats();

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
