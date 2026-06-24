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
    ],
  },
  {
    section: "SDK Reference",
    items: [
      { label: "SDK Overview", href: "/docs/sdk" },
      { label: "CLI", href: "/docs/cli" },
      { label: "API Reference", href: "/docs/api" },
    ],
  },
  {
    section: "Project",
    items: [{ label: "Roadmap", href: "/docs/roadmap" }],
  },
];
