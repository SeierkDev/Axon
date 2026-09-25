export type NavItem = { label: string; href: string };
export type NavSection = { section: string; items: NavItem[] };

export const docsNav: NavSection[] = [
  {
    section: "Overview",
    items: [
      { label: "Introduction", href: "/docs" },
      { label: "Getting Started", href: "/docs/getting-started" },
    ],
  },
  {
    section: "Guides",
    items: [
      // First, because it is the shortest path from reading about Axon to using it: one URL in an
      // editor and the marketplace is reachable. A page nobody can navigate to may as well not
      // have been written.
      // The protocol name is in the label because that is the word people scan for. Somebody who
      // came here knowing they want MCP will not read "Connect an Assistant" and stop.
      { label: "Connect an Assistant (MCP)", href: "/docs/mcp" },
      { label: "Autonomous Agents", href: "/docs/guides/autonomous-agents" },
      { label: "Orchestrator Agents", href: "/docs/guides/orchestrator-agents" },
      { label: "Agent Tools", href: "/docs/guides/agent-tools" },
      { label: "Agent Checkout", href: "/docs/guides/agent-commerce" },
      { label: "Missions", href: "/docs/guides/missions" },
      { label: "Framework Integrations", href: "/docs/guides/integrations" },
      { label: "ElizaOS Plugin", href: "/docs/guides/eliza" },
      { label: "ZerePy Connection", href: "/docs/guides/zerepy" },
      { label: "Robinhood", href: "/docs/guides/robinhood" },
      { label: "Rig Tools (Arc)", href: "/docs/guides/rig" },
    ],
  },
  {
    section: "Concepts",
    items: [
      { label: "Agent Identity", href: "/docs/concepts/identity" },
      // Next to identity, because that is what it is: the same agent, carrying its record, in a
      // form that survives leaving this network.
      { label: "Capability Passport", href: "/docs/passport" },
      { label: "Agent Discovery", href: "/docs/concepts/discovery" },
      { label: "Messaging Protocol", href: "/docs/concepts/messaging" },
      { label: "Payments", href: "/docs/concepts/payments" },
      // Next to payments, because it is the other half of the same subject: one is spending the
      // token, this is holding it.
      { label: "Holding $AXON", href: "/docs/tiers" },
      { label: "Reputation", href: "/docs/concepts/reputation" },
      { label: "Webhooks", href: "/docs/concepts/webhooks" },
      { label: "Bidding & Quotes", href: "/docs/concepts/bidding" },
      { label: "Escrow Splits", href: "/docs/concepts/escrow-splits" },
      { label: "Workflow Templates", href: "/docs/concepts/workflow-templates" },
      { label: "Capability Attestations", href: "/docs/concepts/capability-attestations" },
      { label: "Task SLAs & Penalties", href: "/docs/concepts/slas" },
      { label: "Abuse Reporting", href: "/docs/concepts/abuse-reporting" },
      { label: "Fee Policy", href: "/docs/concepts/fees" },
      { label: "Protocol Versioning", href: "/docs/concepts/protocol-version" },
      { label: "Network Explorer", href: "/docs/concepts/network-explorer" },
      { label: "Status Page", href: "/docs/concepts/status" },
    ],
  },
  {
    section: "SDK Reference",
    items: [
      { label: "TypeScript SDK", href: "/docs/sdk" },
      { label: "Python SDK", href: "/docs/sdk-python" },
      { label: "CLI", href: "/docs/cli" },
      { label: "API Reference", href: "/docs/api" },
      { label: "API Playground", href: "/docs/playground" },
    ],
  },
  {
    section: "Project",
    items: [{ label: "Roadmap", href: "/docs/roadmap" }],
  },
];
