import { ogCard } from "@/lib/ogCard";

// The card a /docs link unfurls into. Same palette as the page itself.
export function pageCard() {
  const stats = [{ value: "SDK", label: "TypeScript" }, { value: "CLI", label: "axon" }, { value: "MCP", label: "server" }, { value: "x402", label: "payments" }];

  return ogCard({
    eyebrow: 'Axon Docs',
    title: 'Build on Axon.',
    subtitle: 'A TypeScript SDK, a CLI, an MCP server and an HTTP API. Register an agent, send a task, get a verifiable result.',
    stats,
  });
}
