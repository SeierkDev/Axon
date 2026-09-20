// Generated activity must not distort what the network reports it moved.
//
// The cron writes a settlement for every demo task it completes. The amount came from the agent's
// listed price, falling back to a flat 0.10 when there was none. On this chain that reads as
// 0.10 ETH, several hundred times what any listed agent charges, and most registered agents carry
// no price at all, so it was nearly every settlement: it alone produced the reported weekly volume.

import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { backfillDemoSettlementAmounts, UNPRICED_AGENT_ETH } from "@/lib/agentSeed";
import type { Agent } from "@/sdk/types";

let n = 0;
function agent(price: string | null): Agent {
  const id = `set-${++n}`;
  const a: Agent = {
    agentId: id, name: `Settle ${id}`, capabilities: ["research"],
    publicKey: `pk-${id}`, provider: "anthropic", price: price ?? undefined,
    reputation: 0, createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

/** A generated settlement, exactly as the cron writes one: no signature of any kind. */
function settlement(to: string, amount: number, currency = "USDC") {
  const id = `stx-${++n}`;
  getDb()
    .prepare(
      `INSERT INTO transactions
         (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature,
          fee_amount, currency, created_at, settled_at)
       VALUES (?, NULL, 'someone', ?, ?, 'completed', NULL, 0, ?, ?, ?)`,
    )
    .run(id, to, amount, currency, new Date().toISOString(), new Date().toISOString());
  return id;
}
const read = (id: string) =>
  getDb().prepare("SELECT amount_eth, currency FROM transactions WHERE tx_id = ?").get(id) as
    { amount_eth: number; currency: string };

describe("the fallback settlement amount", () => {
  it("is in the same band as a listed agent, not hundreds of times it", () => {
    expect(UNPRICED_AGENT_ETH).toBeGreaterThan(0);
    expect(UNPRICED_AGENT_ETH).toBeLessThanOrEqual(0.0005);
  });

  it("corrects an old flat-rate row for an agent that never listed a price", () => {
    const a = agent(null);
    const tx = settlement(a.agentId, 0.10);

    backfillDemoSettlementAmounts(getDb());

    const row = read(tx);
    expect(row.amount_eth).toBeCloseTo(UNPRICED_AGENT_ETH, 9);
    expect(row.currency).toBe("ETH");
  });

  it("uses the listed price when there is one", () => {
    const a = agent("0.00025 ETH");
    const tx = settlement(a.agentId, 0.10);

    backfillDemoSettlementAmounts(getDb());

    expect(read(tx).amount_eth).toBeCloseTo(0.00025, 9);
  });

  it("never rewrites a settlement that actually moved funds", () => {
    const a = agent("0.00025 ETH");
    const id = `real-${++n}`;
    getDb()
      .prepare(
        `INSERT INTO transactions
           (tx_id, task_id, from_agent, to_agent, amount_eth, status, signature,
            fee_amount, currency, created_at, settled_at)
         VALUES (?, NULL, 'someone', ?, 0.5, 'completed', '0xrealhash', 0, 'ETH', ?, ?)`,
      )
      .run(id, a.agentId, new Date().toISOString(), new Date().toISOString());

    backfillDemoSettlementAmounts(getDb());

    expect(read(id).amount_eth).toBe(0.5);
  });

  it("is idempotent", () => {
    const a = agent(null);
    const tx = settlement(a.agentId, 0.10);
    backfillDemoSettlementAmounts(getDb());
    const once = read(tx).amount_eth;
    expect(backfillDemoSettlementAmounts(getDb())).toBe(0);
    expect(read(tx).amount_eth).toBe(once);
  });
});
