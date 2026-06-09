import { describe, it, expect } from "vitest";
import { createBudget, getBudget, checkBudget, deleteBudget } from "@/lib/budgets";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import type { Agent } from "@/sdk/types";

// Global counter — never reset, keeps IDs unique across all tests in this file
let counter = 0;

// Minimal valid Solana address (base58, 32 chars)
const TEST_WALLET = "11111111111111111111111111111111";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `bgt-${counter}`,
    name: `Budget Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pubkey${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("createBudget / getBudget", () => {
  it("creates a budget and retrieves it with zero spend", () => {
    const agent = makeAgent();
    createAgent(agent);

    createBudget({ agentId: agent.agentId, maxPerCallUsdc: 1.0, maxPerDayUsdc: 10.0 });
    const status = getBudget(agent.agentId);

    expect(status).not.toBeNull();
    expect(status!.maxPerCallUsdc).toBe(1.0);
    expect(status!.maxPerDayUsdc).toBe(10.0);
    expect(status!.spentTodayUsdc).toBe(0);
    expect(status!.remainingTodayUsdc).toBe(10.0);
  });

  it("returns null when no budget exists", () => {
    const agent = makeAgent();
    createAgent(agent);
    expect(getBudget(agent.agentId)).toBeNull();
  });

  it("upserting replaces existing budget", () => {
    const agent = makeAgent();
    createAgent(agent);

    createBudget({ agentId: agent.agentId, maxPerCallUsdc: 1.0 });
    createBudget({ agentId: agent.agentId, maxPerCallUsdc: 2.0, maxPerDayUsdc: 20.0 });

    const status = getBudget(agent.agentId);
    expect(status!.maxPerCallUsdc).toBe(2.0);
    expect(status!.maxPerDayUsdc).toBe(20.0);
  });
});

describe("checkBudget", () => {
  it("passes when no budget exists (no restrictions)", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);
    expect(() => checkBudget(a.agentId, b.agentId, 100)).not.toThrow();
  });

  it("throws when per-call limit is exceeded", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);
    createBudget({ agentId: a.agentId, maxPerCallUsdc: 0.5 });

    expect(() => checkBudget(a.agentId, b.agentId, 0.6)).toThrow(/per-call cap/);
    expect(() => checkBudget(a.agentId, b.agentId, 0.5)).not.toThrow();
  });

  it("throws when calling a disallowed agent", () => {
    const a = makeAgent();
    const b = makeAgent();
    const c = makeAgent();
    createAgent(a);
    createAgent(b);
    createAgent(c);
    createBudget({ agentId: a.agentId, allowedToAgents: [b.agentId] });

    expect(() => checkBudget(a.agentId, c.agentId, 0.1)).toThrow(/not allowed/);
    expect(() => checkBudget(a.agentId, b.agentId, 0.1)).not.toThrow();
  });
});

describe("checkBudget: daily cap", () => {
  it("throws when daily USDC spend exceeds the daily cap", () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);
    createBudget({ agentId: sender.agentId, maxPerCallUsdc: 100, maxPerDayUsdc: 5 });

    // Insert a fake transaction representing 4 USDC spent today
    const today = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO transactions (tx_id, from_agent, to_agent, amount_sol, fee_amount, currency, status, created_at)
      VALUES (?, ?, ?, 4, 0, 'USDC', 'escrow', ?)
    `).run(randomUUID(), sender.agentId, receiver.agentId, today);

    // 2 more would exceed the 5 USDC daily limit (4 + 2 > 5)
    expect(() => checkBudget(sender.agentId, receiver.agentId, 2)).toThrow(/daily cap/);
  });

  it("allows spend within the daily cap", () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);
    createBudget({ agentId: sender.agentId, maxPerCallUsdc: 100, maxPerDayUsdc: 10 });

    // Insert a fake transaction for 3 USDC today
    const today = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO transactions (tx_id, from_agent, to_agent, amount_sol, fee_amount, currency, status, created_at)
      VALUES (?, ?, ?, 3, 0, 'USDC', 'completed', ?)
    `).run(randomUUID(), sender.agentId, receiver.agentId, today);

    // 2 more (3 + 2 = 5 <= 10) should be allowed
    expect(() => checkBudget(sender.agentId, receiver.agentId, 2)).not.toThrow();
  });
});

describe("deleteBudget", () => {
  it("removes an existing budget", () => {
    const agent = makeAgent();
    createAgent(agent);
    createBudget({ agentId: agent.agentId, maxPerCallUsdc: 1.0 });
    expect(getBudget(agent.agentId)).not.toBeNull();

    deleteBudget(agent.agentId);
    expect(getBudget(agent.agentId)).toBeNull();
  });

  it("is idempotent when no budget exists", () => {
    const agent = makeAgent();
    createAgent(agent);
    expect(() => deleteBudget(agent.agentId)).not.toThrow();
  });
});

// ── checkBudget: malformed JSON fallthrough (session 7 bug fix) ───────────────
// Before the fix, catch { return; } would silently bypass the daily cap.
// After the fix, the daily cap is still enforced when allowed_to_agents JSON is corrupt.

describe("checkBudget: malformed allowed_to_agents falls through to daily cap", () => {
  it("throws 'daily cap' rather than silently passing when allowed_to_agents JSON is corrupt", () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);
    createBudget({
      agentId: sender.agentId,
      allowedToAgents: [receiver.agentId],
      maxPerDayUsdc: 0.5,
    });

    // Corrupt the column to simulate DB-level data corruption
    getDb()
      .prepare("UPDATE agent_budgets SET allowed_to_agents = 'not-valid-json' WHERE agent_id = ?")
      .run(sender.agentId);

    // Pre-spend 0.4 USDC; adding 0.2 more would exceed the 0.5 daily cap
    getDb().prepare(`
      INSERT INTO transactions (tx_id, from_agent, to_agent, amount_sol, fee_amount, currency, status, created_at)
      VALUES (?, ?, ?, 0.4, 0, 'USDC', 'completed', ?)
    `).run(randomUUID(), sender.agentId, receiver.agentId, new Date().toISOString());

    // Must throw daily cap error — the malformed JSON must NOT cause a silent pass
    expect(() => checkBudget(sender.agentId, receiver.agentId, 0.2)).toThrow(/daily cap/);
  });

  it("does not throw when allowed_to_agents JSON is corrupt but daily cap has headroom", () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);
    createBudget({
      agentId: sender.agentId,
      allowedToAgents: [receiver.agentId],
      maxPerDayUsdc: 5.0,
    });

    // Corrupt the column
    getDb()
      .prepare("UPDATE agent_budgets SET allowed_to_agents = '{bad' WHERE agent_id = ?")
      .run(sender.agentId);

    // No prior spend + cap of 5.0 → should pass (restriction check skipped, daily cap passes)
    expect(() => checkBudget(sender.agentId, receiver.agentId, 1.0)).not.toThrow();
  });
});

// ── checkBudget: getBudget with no daily cap returns null remainingTodayUsdc ──

describe("getBudget: null remainingTodayUsdc when no daily cap is configured", () => {
  it("returns null for remainingTodayUsdc when maxPerDayUsdc is not set", () => {
    const agent = makeAgent();
    createAgent(agent);
    createBudget({ agentId: agent.agentId, maxPerCallUsdc: 1.0 }); // no maxPerDayUsdc
    const status = getBudget(agent.agentId)!;
    expect(status.remainingTodayUsdc).toBeNull();
  });
});
