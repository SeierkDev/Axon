import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { backfillDemoSettlementAmounts } from "@/lib/agentSeed";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

function insertTx(toAgent: string, amount: number, opts: { incoming?: string; signature?: string } = {}): string {
  const txId = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, signature, fee_amount, currency, created_at, settled_at)
       VALUES (?, NULL, 'req', ?, ?, 'completed', ?, ?, 0, 'USDC', ?, ?)`
    )
    .run(txId, toAgent, amount, opts.incoming ?? null, opts.signature ?? null, now, now);
  return txId;
}

function amountOf(txId: string): number {
  return (getDb().prepare("SELECT amount_sol FROM transactions WHERE tx_id = ?").get(txId) as { amount_sol: number }).amount_sol;
}

describe("demo settlement amount backfill", () => {
  it("corrects synthetic demo settlements to the agent's price, leaves signed ones, is idempotent", () => {
    const agentId = `priced-${randomUUID().slice(0, 8)}`;
    const agent: Agent = {
      agentId,
      name: "Priced Agent",
      capabilities: ["x"],
      publicKey: `pk-${agentId}`,
      provider: "anthropic",
      reputation: 0,
      price: "0.15 USDC",
      createdAt: new Date().toISOString(),
    };
    createAgent(agent);

    const demo = insertTx(agentId, 0.1); // synthetic — no signatures
    const real = insertTx(agentId, 0.1, { incoming: "onchain-incoming-sig" }); // real, signed

    backfillDemoSettlementAmounts(getDb());

    expect(amountOf(demo)).toBeCloseTo(0.15); // corrected to the agent's price
    expect(amountOf(real)).toBeCloseTo(0.1); // signed settlement untouched

    // Idempotent — a second pass leaves the corrected row unchanged.
    const before = amountOf(demo);
    backfillDemoSettlementAmounts(getDb());
    expect(amountOf(demo)).toBe(before);
  });

  it("does nothing for an agent with no valid price", () => {
    const agentId = `nopr-${randomUUID().slice(0, 8)}`;
    createAgent({
      agentId,
      name: "No Price Agent",
      capabilities: ["x"],
      publicKey: `pk-${agentId}`,
      provider: "anthropic",
      reputation: 0,
      createdAt: new Date().toISOString(),
    });
    const tx = insertTx(agentId, 0.1);
    backfillDemoSettlementAmounts(getDb());
    expect(amountOf(tx)).toBeCloseTo(0.1); // left as-is (no price to apply)
  });
});
