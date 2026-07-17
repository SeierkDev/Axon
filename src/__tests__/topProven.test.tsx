// Reputation-routed discovery — the Top Proven board. Renders the component to
// static markup (node, no DOM needed) so its real output is exercised: ranking
// by Proof Score, the 5-agent cap, the honest "View" CTA, and the empty state.

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "@/sdk/types";

// next/link needs no router for static markup — render it as a plain anchor.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// Imported AFTER the mock so TopProven picks up the stubbed Link.
const { TopProven } = await import("@/app/agents/TopProven");

let n = 0;
function agent(overrides: Partial<Agent>): Agent {
  n++;
  return {
    agentId: `a${n}`,
    name: `Agent ${n}`,
    capabilities: ["research"],
    publicKey: `pk${n}`,
    provider: "anthropic",
    reputation: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("TopProven board", () => {
  it("renders nothing until an agent has actually earned a Proof Score", () => {
    const html = renderToStaticMarkup(<TopProven agents={[agent({ name: "Unscored" })]} />);
    expect(html).toBe("");
  });

  it("ranks strictly by Proof Score, ignoring input order, and shows score + tier + View", () => {
    const html = renderToStaticMarkup(
      <TopProven
        agents={[
          agent({ agentId: "lo", name: "LowScore", proofScore: 300, proofScoreTier: "Emerging" }),
          agent({ agentId: "hi", name: "HighScore", proofScore: 950, proofScoreTier: "Elite" }),
          agent({ agentId: "mid", name: "MidScore", proofScore: 600, proofScoreTier: "Established" }),
        ]}
      />,
    );
    // highest first, regardless of the order passed in
    expect(html.indexOf("HighScore")).toBeLessThan(html.indexOf("MidScore"));
    expect(html.indexOf("MidScore")).toBeLessThan(html.indexOf("LowScore"));
    // the real figures + tier show, and the CTA is the honest "View" (not "Hire")
    expect(html).toContain("950");
    expect(html).toContain("Elite");
    expect(html).toContain("View");
    expect(html).not.toContain("Hire");
    // links to the agent's proof page
    expect(html).toContain('href="/agents/hi"');
  });

  it("caps the board at 5 agents even when more are scored", () => {
    const agents = Array.from({ length: 9 }, (_, i) =>
      agent({ agentId: `s${i}`, name: `Scored${i}`, proofScore: 100 + i * 10, proofScoreTier: "New" }),
    );
    const html = renderToStaticMarkup(<TopProven agents={agents} />);
    const rows = (html.match(/href="\/agents\//g) ?? []).length;
    expect(rows).toBe(5);
  });
});
