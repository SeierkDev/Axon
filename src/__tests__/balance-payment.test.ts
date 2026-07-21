import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import {
  createBalancePayment,
  getAvailableBalance,
  getAgentBalance,
  releasePayment,
  releaseWithPenalty,
  refundPayment,
  getPaymentByTaskId,
} from "@/lib/payments";
import { POST } from "@/app/api/tasks/route";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { defineSplits } from "@/lib/escrowSplits";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let counter = 0;
function makeAgent(wallet = WALLET): Agent {
  counter++;
  const a: Agent = {
    agentId: `bal-${counter}-${randomUUID().slice(0, 8)}`,
    name: `Balance Agent ${counter}`,
    capabilities: ["x"],
    publicKey: `pk-bal-${counter}-${randomUUID().slice(0, 6)}`,
    walletAddress: wallet,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}
function paidAgent(price = "0.25 USDC"): Agent {
  const a = makeAgent();
  getDb().prepare("UPDATE agents SET price = ? WHERE agent_id = ?").run(price, a.agentId);
  return { ...a, price };
}

// Simulate an agent EARNING USDC — a completed payout crediting its balance,
// exactly the shape releasePayment produces when it gets hired.
function credit(agentId: string, amount: number): void {
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at)
       VALUES (?, NULL, ?, ?, ?, 'completed', NULL, 0, 'USDC', ?, ?)`
    )
    .run(randomUUID(), "external-seed", agentId, amount, new Date().toISOString(), new Date().toISOString());
}

// An ON-CHAIN hire the agent funded from its own wallet: a completed from_agent
// spend carrying a real signature (funding_source stays NULL — external money).
function onchainSpend(from: string, to: string, amount: number): void {
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at)
       VALUES (?, NULL, ?, ?, ?, 'completed', ?, 0, 'USDC', ?, ?)`
    )
    .run(randomUUID(), from, to, amount, `onchain-${randomUUID()}`, new Date().toISOString(), new Date().toISOString());
}

describe("pay-from-balance", () => {
  it("available balance = earned − spent − escrow (USDC)", () => {
    const a = makeAgent();
    expect(getAvailableBalance(a.agentId)).toBe(0);
    credit(a.agentId, 10);
    expect(getAvailableBalance(a.agentId)).toBe(10);
  });

  it("spends earned balance and holds it in escrow until settled", () => {
    const payer = makeAgent();
    const payee = makeAgent();
    credit(payer.agentId, 10);

    const taskId = `task-${randomUUID()}`;
    const p = createBalancePayment({ taskId, fromAgent: payer.agentId, toAgent: payee.agentId, amountSol: 3, priceString: "3 USDC" });
    expect(p.status).toBe("escrow");
    expect(p.incomingSignature ?? null).toBeNull();

    // escrowed: available drops by 3, but it isn't "spent" yet
    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(7, 6);
    expect(getAgentBalance(payer.agentId).totalEscrow).toBeCloseTo(3, 6);
    expect(getAvailableBalance(payee.agentId)).toBe(0);
  });

  it("settling credits the payee and debits the payer — value conserved", () => {
    const payer = makeAgent();
    const payee = makeAgent();
    credit(payer.agentId, 10);
    const taskId = `task-${randomUUID()}`;
    createBalancePayment({ taskId, fromAgent: payer.agentId, toAgent: payee.agentId, amountSol: 4, priceString: "4 USDC" });

    releasePayment(taskId);

    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(6, 6); // 10 earned − 4 spent
    expect(getAvailableBalance(payee.agentId)).toBeCloseTo(4, 6); // earned 4
    // conservation: the 10 that entered the system is exactly payer(6) + payee(4)
    expect(getAvailableBalance(payer.agentId) + getAvailableBalance(payee.agentId)).toBeCloseTo(10, 6);
  });

  it("refunding restores the payer's available balance", () => {
    const payer = makeAgent();
    const payee = makeAgent();
    credit(payer.agentId, 10);
    const taskId = `task-${randomUUID()}`;
    createBalancePayment({ taskId, fromAgent: payer.agentId, toAgent: payee.agentId, amountSol: 5, priceString: "5 USDC" });
    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(5, 6);

    refundPayment(taskId);

    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(10, 6);
    expect(getAvailableBalance(payee.agentId)).toBe(0);
    expect(getPaymentByTaskId(taskId)?.status).toBe("refunded");
  });

  it("rejects a hire the agent can't afford", () => {
    const payer = makeAgent();
    const payee = makeAgent();
    credit(payer.agentId, 2);
    expect(() =>
      createBalancePayment({ taskId: `task-${randomUUID()}`, fromAgent: payer.agentId, toAgent: payee.agentId, amountSol: 5, priceString: "5 USDC" })
    ).toThrow(/insufficient balance/i);
    // nothing was escrowed
    expect(getAvailableBalance(payer.agentId)).toBe(2);
  });

  it("can't be double-spent past the available balance", () => {
    const payer = makeAgent();
    const payee = makeAgent();
    credit(payer.agentId, 5);
    createBalancePayment({ taskId: `task-${randomUUID()}`, fromAgent: payer.agentId, toAgent: payee.agentId, amountSol: 4, priceString: "4 USDC" });
    // only 1 left in escrow-adjusted available — a second 4 must fail
    expect(() =>
      createBalancePayment({ taskId: `task-${randomUUID()}`, fromAgent: payer.agentId, toAgent: payee.agentId, amountSol: 4, priceString: "4 USDC" })
    ).toThrow(/insufficient balance/i);
    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(1, 6);
  });

  it("requires a registered paying agent", () => {
    const payee = makeAgent();
    expect(() =>
      createBalancePayment({ taskId: `task-${randomUUID()}`, fromAgent: "not-an-agent", toAgent: payee.agentId, amountSol: 1, priceString: "1 USDC" })
    ).toThrow(/registered paying agent/i);
  });

  it("on-chain hires (funded externally) don't reduce spendable earned balance", () => {
    const x = makeAgent();
    const y = makeAgent();
    credit(x.agentId, 10);
    onchainSpend(x.agentId, y.agentId, 5); // paid from x's OWN wallet, not its earnings
    // earned balance is still the full 10 — the on-chain hire was external money
    expect(getAvailableBalance(x.agentId)).toBeCloseTo(10, 6);
    // and x can still spend all 10 from balance
    createBalancePayment({ taskId: `task-${randomUUID()}`, fromAgent: x.agentId, toAgent: y.agentId, amountSol: 10, priceString: "10 USDC" });
    expect(getAvailableBalance(x.agentId)).toBeCloseTo(0, 6);
  });

  it("a balance-funded split still counts as the payer's spend", () => {
    const payer = makeAgent();
    const r1 = makeAgent();
    const r2 = makeAgent();
    credit(payer.agentId, 10);
    const taskId = `task-${randomUUID()}`;
    defineSplits(taskId, [
      { agentId: r1.agentId, shareBps: 5000 },
      { agentId: r2.agentId, shareBps: 5000 },
    ]);
    createBalancePayment({ taskId, fromAgent: payer.agentId, toAgent: r1.agentId, amountSol: 4, priceString: "4 USDC" });
    releasePayment(taskId); // routes through releaseWithSplits

    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(6, 6); // 10 − 4 spent from balance
    expect(getAvailableBalance(r1.agentId)).toBeCloseTo(2, 6);
    expect(getAvailableBalance(r2.agentId)).toBeCloseTo(2, 6);
  });

  it("a balance-funded hire settled with an SLA penalty draws down balance correctly", () => {
    const payer = makeAgent();
    const payee = makeAgent();
    credit(payer.agentId, 10);
    const taskId = `task-${randomUUID()}`;
    createBalancePayment({ taskId, fromAgent: payer.agentId, toAgent: payee.agentId, amountSol: 4, priceString: "4 USDC" });
    releaseWithPenalty(taskId, 2500); // 25% late penalty: provider gets 3, 1 returned to payer

    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(7, 6); // 10 − 3 spent (1 penalty came back)
    expect(getAvailableBalance(payee.agentId)).toBeCloseTo(3, 6);
  });
});

describe("pay-from-balance — full route flow (POST /api/tasks)", () => {
  // An authenticated agent whose wallet owns it, so canAccessIdentity passes.
  function authedAgent(): { agent: Agent; apiKey: string } {
    const wallet = `Wa11et${randomUUID().replace(/-/g, "").slice(0, 26)}`;
    const agent = makeAgent(wallet);
    const { apiKey } = createApiKey(wallet);
    return { agent, apiKey };
  }
  async function hire(from: string, to: string, apiKey: string | null) {
    const req = new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ from, to, task: "do the thing", paymentMethod: "balance" }),
    });
    const res = await POST(req);
    return { res, body: (await res.json()) as { taskId?: string; error?: string; code?: string } };
  }

  it("an authenticated agent hires a paid agent from its balance, and it settles", async () => {
    const { agent: payer, apiKey } = authedAgent();
    credit(payer.agentId, 1);
    const payee = paidAgent("0.25 USDC");

    const { res, body } = await hire(payer.agentId, payee.agentId, apiKey);
    expect(res.status).toBe(201);
    expect(body.taskId).toBeTruthy();
    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(0.75, 6); // 0.25 escrowed

    releasePayment(body.taskId!);
    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(0.75, 6); // 1 earned − 0.25 spent
    expect(getAvailableBalance(payee.agentId)).toBeCloseTo(0.25, 6);
  });

  it("rejects (402) and rolls back the task when the agent can't afford it", async () => {
    const { agent: payer, apiKey } = authedAgent();
    credit(payer.agentId, 0.1);
    const payee = paidAgent("0.25 USDC");

    const { res, body } = await hire(payer.agentId, payee.agentId, apiKey);
    expect(res.status).toBe(402);
    expect(body.taskId).toBeFalsy();
    expect(getAvailableBalance(payer.agentId)).toBeCloseTo(0.1, 6); // untouched
  });

  it("requires authentication (401 without an API key)", async () => {
    const payer = makeAgent();
    credit(payer.agentId, 1);
    const payee = paidAgent("0.25 USDC");
    const { res } = await hire(payer.agentId, payee.agentId, null);
    expect(res.status).toBe(401);
  });

  it("rejects an anonymous payer (no balance identity)", async () => {
    const payee = paidAgent("0.25 USDC");
    const { res, body } = await hire("anonymous", payee.agentId, null);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/registered paying agent/i);
  });
});
