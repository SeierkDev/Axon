// Tests for src/lib/providers.ts
// getAgentSystem: pure lookup — no mocking needed
// getProvider: tests error paths only — no API calls made
// runWithProvider: not tested here (requires live external API)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Agent } from "@/sdk/types";
import { getAgentSystem, getProvider } from "@/lib/providers";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: "test-agent",
    name: "Test Agent",
    capabilities: ["chat"],
    publicKey: "pk-test",
    walletAddress: "11111111111111111111111111111111",
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── getAgentSystem ─────────────────────────────────────────────────────────────

describe("getAgentSystem: known agents", () => {
  it("returns a non-empty system prompt for research-agent", () => {
    const system = getAgentSystem(makeAgent({ agentId: "research-agent" }));
    expect(typeof system).toBe("string");
    expect(system.length).toBeGreaterThan(0);
  });

  it("returns different prompts for different known agent IDs", () => {
    const research = getAgentSystem(makeAgent({ agentId: "research-agent" }));
    const code     = getAgentSystem(makeAgent({ agentId: "code-agent" }));
    expect(research).not.toBe(code);
  });

  it("returns a non-empty system prompt for all known agent IDs", () => {
    const knownIds = [
      "research-agent", "crypto-agent",  "trading-agent",
      "audit-agent",    "defi-agent",    "data-agent",
      "content-agent",  "code-agent",    "onchain-agent",
      "strategy-agent", "seo-agent",     "social-agent",
      "email-agent",    "report-agent",  "web-agent",
    ];
    for (const agentId of knownIds) {
      const system = getAgentSystem(makeAgent({ agentId }));
      expect(system.length, `system prompt for ${agentId} should not be empty`).toBeGreaterThan(0);
    }
  });
});

describe("getAgentSystem: unknown agent", () => {
  it("returns a generic fallback containing the agent name and capabilities", () => {
    const a = makeAgent({
      agentId: "custom-xyz",
      name: "My Custom Agent",
      capabilities: ["data-analysis", "reporting"],
    });
    const system = getAgentSystem(a);
    expect(system).toContain("My Custom Agent");
    expect(system).toContain("data-analysis");
    expect(system).toContain("reporting");
  });
});

// ── getProvider error paths ────────────────────────────────────────────────────

describe("getProvider: anthropic — missing API key", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("throws when ANTHROPIC_API_KEY is not set", () => {
    expect(() => getProvider(makeAgent({ provider: "anthropic" }))).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("getProvider: openai — missing API key", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  });

  it("throws when OPENAI_API_KEY is not set", () => {
    expect(() => getProvider(makeAgent({ provider: "openai" }))).toThrow(/OPENAI_API_KEY/);
  });
});

describe("getProvider: openai — custom endpoint not supported", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  });

  it("throws when providerEndpoint is set for an openai agent", () => {
    const a = makeAgent({
      provider: "openai",
      providerEndpoint: "https://custom.openai.local/v1",
    });
    expect(() => getProvider(a)).toThrow(/providerEndpoint/);
  });
});

describe("getProvider: ollama — missing endpoint", () => {
  it("throws when providerEndpoint is not set", () => {
    const a = makeAgent({ provider: "ollama", providerEndpoint: undefined });
    expect(() => getProvider(a)).toThrow(/providerEndpoint/);
  });

  it("does not throw when providerEndpoint is set", () => {
    const a = makeAgent({
      provider: "ollama",
      providerEndpoint: "https://ollama.example.com",
    });
    expect(() => getProvider(a)).not.toThrow();
  });
});

describe("getProvider: unknown provider", () => {
  it("throws for an unrecognized provider string", () => {
    // Cast to bypass TypeScript's InferenceProvider union — simulates a runtime value
    const a = makeAgent({ provider: "gemini" as "anthropic" });
    expect(() => getProvider(a)).toThrow(/Unknown inference provider/);
  });
});
