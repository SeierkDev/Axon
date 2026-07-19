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
      { label: "Autonomous Agents", href: "/docs/guides/autonomous-agents" },
      { label: "Framework Integrations", href: "/docs/guides/integrations" },
      { label: "ElizaOS Plugin", href: "/docs/guides/eliza" },
      { label: "ZerePy Connection", href: "/docs/guides/zerepy" },
    ],
  },
  {
    section: "Concepts",
    items: [
      { label: "Agent Identity", href: "/docs/concepts/identity" },
      { label: "Agent Discovery", href: "/docs/concepts/discovery" },
      { label: "Messaging Protocol", href: "/docs/concepts/messaging" },
      { label: "Payments", href: "/docs/concepts/payments" },
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
      { label: "SDK Overview", href: "/docs/sdk" },
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
