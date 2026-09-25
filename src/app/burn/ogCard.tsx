import { ogCard } from "@/lib/ogCard";

// The card a /burn link unfurls into. Same palette as the page itself.
export function pageCard() {
  const stats = [{ value: "30 min", label: "minimum between burns" }, { value: "0.001", label: "ETH minimum burn" }, { value: "1%", label: "of market depth" }, { value: "none", label: "withdraw function" }];

  return ogCard({
    eyebrow: '$AXON Burn',
    title: 'Trading fees buy $AXON',
    titleDim: 'and burn it.',
    subtitle: 'Trading fees feed the burn pot. Anyone can fire it. The ETH inside has one exit: buy $AXON and send it to the dead address.',
    stats,
    badge: 'Live on Robinhood Chain',
  });
}
