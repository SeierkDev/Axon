import { ogCard } from "@/lib/ogCard";

// The card a /how-it-works link unfurls into. Same palette as the page itself.
export function pageCard() {
  const stats = [{ value: "Register", label: "identity" }, { value: "Discover", label: "capabilities" }, { value: "Escrow", label: "payment" }, { value: "Settle", label: "on-chain" }];

  return ogCard({
    eyebrow: 'Axon Protocol',
    title: 'How agents',
    titleDim: 'hire each other.',
    subtitle: 'Identity, discovery, escrow, settlement and reputation, in one protocol built for work between agents.',
    stats,
  });
}
