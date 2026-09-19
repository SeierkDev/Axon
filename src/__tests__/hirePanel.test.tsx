// HirePanel branches: free lane, in-browser paid (USDC + wallet config), and the
// API/MCP fallback (SOL price or unset config). Rendered to static markup so the
// real branching is exercised.

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// next/link needs no router for static markup — render it as a plain anchor.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// Imported AFTER the mock so HirePanel picks up the stubbed Link.
const { default: HirePanel } = await import("@/app/agents/[agentId]/HirePanel");

const RECEIVER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const RPC = "https://rpc.example";

describe("HirePanel — render branches", () => {
  it("free agent: shows the Free lane hire, not a pay button", () => {
    const html = renderToStaticMarkup(
      <HirePanel agentId="a" agentName="Agent" isPaid={false} price={null} receiver={RECEIVER} rpcUrl={RPC} />,
    );
    expect(html).toContain("Free lane");
    expect(html).toContain(">Hire<");
    expect(html).not.toMatch(/Pay .* &amp; Hire/);
  });

  it("paid agent with wallet config: shows the in-browser pay-and-hire button", () => {
    const html = renderToStaticMarkup(
      <HirePanel agentId="a" agentName="Agent" isPaid price="0.00025 ETH" receiver={RECEIVER} rpcUrl={RPC} />,
    );
    expect(html).toContain("Pay 0.00025 ETH");
    expect(html).toContain("Hire");
    // it's the interactive panel, not the API/MCP fallback note
    expect(html).not.toContain("Hire via the");
  });

  it("paid agent but wallet config unset: falls back to the API/MCP note", () => {
    const html = renderToStaticMarkup(
      <HirePanel agentId="a" agentName="Agent" isPaid price="0.00025 ETH" receiver="" rpcUrl="" />,
    );
    expect(html).toContain("API or MCP");
    expect(html).not.toMatch(/Pay .* Hire/);
  });

  // Every price is in the chain's own currency now, so there is no second currency to fall back
  // from. What still falls back is a price the panel cannot read at all.
  it("unparseable price: falls back to the API/MCP note", () => {
    const html = renderToStaticMarkup(
      <HirePanel agentId="a" agentName="Agent" isPaid price="not-a-price" receiver={RECEIVER} rpcUrl={RPC} />,
    );
    expect(html).toContain("API or MCP");
    expect(html).not.toMatch(/Pay .* Hire/);
  });
});
