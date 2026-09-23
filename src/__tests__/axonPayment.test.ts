import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "@/lib/db";

/**
 * A refund has to come back in what was paid.
 *
 * The ledger already carried a currency on every row, and release and refund both read it rather than
 * assuming, so most of this was true before anything was written. What was missing was a way to make
 * such a row at all. These tests are mostly about the edges around that: what happens on the paths
 * that genuinely do assume ETH, and whether a refund of $AXON is $AXON, in the amount agreed.
 */

const AXON = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const RECEIVER = "0x1111111111111111111111111111111111111111";
const SQRT_P = 468867624989588479258801841136883n;
const PRICE_WEI = 250_000_000_000_000n; // 0.00025 ETH, a price agents really list at

let transferOk = true;

const load = async () => {
  vi.resetModules();
  vi.doMock("@/lib/axonPool", async () => {
    const actual = await vi.importActual<typeof import("@/lib/axonPool")>("@/lib/axonPool");
    return { ...actual, readPoolPrice: vi.fn(async () => ({ sqrtPriceX96: SQRT_P, axonPerEth: 35_022_030 })) };
  });
  vi.doMock("@/lib/evm", async () => {
    const actual = await vi.importActual<typeof import("@/lib/evm")>("@/lib/evm");
    return {
      ...actual,
      verifyTransfer: vi.fn(async () => (transferOk ? { ok: true, reason: "ok" } : { ok: false, reason: "no transfer" })),
    };
  });
  // Everything the tests touch is imported here, after the reset, so it all shares one module graph
  // and therefore one database. Importing a helper later would give it a fresh instance, and a split
  // defined in that one is invisible to the code being tested.
  return {
    quote: await import("@/lib/axonQuote"),
    pay: await import("@/lib/axonPayment"),
    burn: await import("@/lib/axonBurn"),
    payments: await import("@/lib/payments"),
    splits: await import("@/lib/escrowSplits"),
    budgets: await import("@/lib/budgets"),
    sla: await import("@/lib/sla"),
    // The database from inside this graph. A reset gives the modules a fresh instance, so seeding or
    // asserting through the one imported at the top of this file would be talking to a different
    // database entirely, and an assertion against it would pass by seeing nothing at all.
    db: (await import("@/lib/db")).getDb(),
  };
};

/** A loaded graph with a clean ledger and the two agents these tests hire between. */
const ready = async () => {
  const mods = await load();
  for (const t of ["axon_quotes", "transactions", "task_splits", "agent_budgets", "axon_payment_burns", "tasks"]) {
    try { mods.db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist yet */ }
  }
  seedAgent(mods.db, "buyer");
  seedAgent(mods.db, "worker");
  return mods;
};

let n = 0;
const nextTx = () => `0x${(++n).toString(16).padStart(64, "0")}`;

const seedAgent = (db: ReturnType<typeof getDb>, id: string) => {
  db
    .prepare(
      `INSERT OR IGNORE INTO agents (agent_id, name, capabilities, public_key, verification_status, created_at, accepts_axon)
       VALUES (?, ?, '[]', ?, 'verified', ?, 1)`,
    )
    .run(id, id, `${id}-key`, new Date().toISOString());
};

describe("paying, and being refunded, in $AXON", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    transferOk = true;
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = RECEIVER;
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  const paidTask = async (mods: Awaited<ReturnType<typeof load>>, taskId: string) => {
    const q = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    if (!q.ok) throw new Error(`quote failed: ${q.reason}`);
    const res = await mods.pay.createAxonPayment({
      taskId, fromAgent: "buyer", toAgent: "worker", quoteId: q.quote.quoteId, txHash: nextTx(),
    });
    return { quote: q.quote, res };
  };

  it("escrows the amount that was quoted, denominated in $AXON", async () => {
    const mods = await ready();
    const { quote, res } = await paidTask(mods, "task-1");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payment.currency).toBe("AXON");

    // The escrow holds the agent's share. The payer's full amount is the pinned quote.
    const shares = mods.burn.splitPayment(quote.axonUnits);
    expect(mods.pay.exactUnits(res.payment.txId)).toBe(shares.toAgent);
    expect(Number(res.payment.paidAmount)).toBeGreaterThan(8_000);
    expect(shares.toAgent + shares.toBurn).toBe(quote.axonUnits);
  });

  it("refunds in $AXON, for the amount that was paid", async () => {
    const mods = await ready();
    const { quote, res } = await paidTask(mods, "task-2");
    if (!res.ok) throw new Error("payment failed");
    const quoteUnits = quote.axonUnits;

    const refunded = mods.payments.refundPayment("task-2");

    expect(refunded).not.toBeNull();
    // The whole point of the part. Not ETH, and not a different number.
    expect(refunded?.currency).toBe("AXON");
    expect(refunded?.status).toBe("refunded");
    // Compared on the exact integer, not on amount_eth, which is a double and cannot hold this.
    // The payer is owed everything they sent, including the part that would have burned.
    expect(mods.pay.refundableUnits(res.payment.txId)).toBe(quoteUnits);
  });

  it("settles to the worker in $AXON when the task succeeds", async () => {
    const mods = await ready();
    const { quote, res } = await paidTask(mods, "task-3");
    if (!res.ok) throw new Error("payment failed");
    const quoteUnits = quote.axonUnits;

    const settled = mods.payments.releasePayment("task-3");

    expect(settled?.currency).toBe("AXON");
    expect(settled?.status).toBe("completed");
    const shares = mods.burn.splitPayment(quoteUnits);
    expect(mods.pay.exactUnits(res.payment.txId)).toBe(shares.toAgent);
  });

  it("keeps $AXON out of the ETH totals", async () => {
    const mods = await ready();
    await paidTask(mods, "task-4");

    // Every aggregate on the site filters on the reporting currency. An AXON row counted as ETH would
    // restate a few thousand tokens as a few thousand ether.
    const rows = mods.db
      .prepare("SELECT currency, COUNT(*) AS n FROM transactions GROUP BY currency")
      .all() as { currency: string; n: number }[];
    // There is a row, and it is not counted as ETH. Asserting only "no ETH rows" would pass against
    // an empty table, which is how this test was wrong the first time.
    expect(rows).toEqual([{ currency: "AXON", n: 1 }]);
  });

  it("will not let one transaction pay twice", async () => {
    const mods = await ready();
    const q = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    if (!q.ok) throw new Error("quote failed");
    const tx = nextTx();

    const first = await mods.pay.createAxonPayment({
      taskId: "task-5", fromAgent: "buyer", toAgent: "worker", quoteId: q.quote.quoteId, txHash: tx,
    });
    const second = await mods.pay.createAxonPayment({
      taskId: "task-6", fromAgent: "buyer", toAgent: "worker", quoteId: q.quote.quoteId, txHash: tx,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("signature-already-used");
  });

  it("records nothing when the transfer was not there", async () => {
    const mods = await ready();
    transferOk = false;
    const q = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    if (!q.ok) throw new Error("quote failed");

    const res = await mods.pay.createAxonPayment({
      taskId: "task-7", fromAgent: "buyer", toAgent: "worker", quoteId: q.quote.quoteId, txHash: nextTx(),
    });

    expect(res.ok).toBe(false);
    const rows = mods.db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("the paths that really do assume ETH", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    transferOk = true;
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = RECEIVER;
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("refuses a task whose escrow is split by share", async () => {
    const mods = await ready();
    mods.splits.defineSplits("task-split", [
      { agentId: "worker", shareBps: 6000 },
      { agentId: "buyer", shareBps: 4000 },
    ]);

    const q = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    if (!q.ok) throw new Error("quote failed");
    const res = await mods.pay.createAxonPayment({
      taskId: "task-split", fromAgent: "buyer", toAgent: "worker", quoteId: q.quote.quoteId, txHash: nextTx(),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("task-has-splits");
    // Refused before the quote is consumed, so the payer still holds a usable quote.
    expect(mods.quote.getQuote(q.quote.quoteId)?.consumedAt).toBeNull();
  });

  it("refuses a payer who has an ETH budget", async () => {
    const mods = await ready();
    mods.budgets.createBudget({ agentId: "buyer", maxPerDayEth: 0.5 });

    const q = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    if (!q.ok) throw new Error("quote failed");
    const res = await mods.pay.createAxonPayment({
      taskId: "task-budget", fromAgent: "buyer", toAgent: "worker", quoteId: q.quote.quoteId, txHash: nextTx(),
    });

    expect(res.ok).toBe(false);
    // A cap of 0.5 ETH compared against nine thousand tokens is not a comparison at all.
    if (!res.ok) expect(res.reason).toBe("payer-has-budget");
  });

  it("refuses a task with an SLA, at agreement rather than at settlement", async () => {
    const mods = await ready();
    // An SLA can only be attached to a task that exists and has not started.
    mods.db
      .prepare(
        `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at)
         VALUES ('task-sla', 'buyer', 'worker', 'audit', 'queued', ?)`,
      )
      .run(new Date().toISOString());
    const defined = mods.sla.defineSla("task-sla", 3600, 2500);
    expect(defined.success, "the SLA must actually be set for this test to mean anything").toBe(true);

    const q = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    if (!q.ok) throw new Error("quote failed");
    const res = await mods.pay.createAxonPayment({
      taskId: "task-sla", fromAgent: "buyer", toAgent: "worker", quoteId: q.quote.quoteId, txHash: nextTx(),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("task-has-sla");
  });
});
