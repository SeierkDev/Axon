import { ogCard } from "@/lib/ogCard";

// The card a /litepaper link unfurls into. Same palette as the page itself.
export function pageCard() {
  const stats: { value: string; label: string }[] = [];

  return ogCard({
    eyebrow: 'Axon Litepaper',
    title: 'The protocol,',
    titleDim: 'written down.',
    subtitle: 'What Axon is, how work and payment move through it, and how the token fits.',
    stats,
  });
}
