import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { splitPayment, BPS } from "@/lib/axonBurn";

/**
 * The share of a payment that stops existing.
 *
 * Almost everything here is about timing rather than arithmetic. A burn is created when a payment is
 * escrowed but must not happen until that payment completes, because a refunded payment was never
 * earned and burning a tenth of it would be taking it from the person whose task failed.
 */

const AXON = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const RECEIVER = "0x1111111111111111111111111111111111111111";
const SQRT_P = 468867624989588479258801841136883n;
const PRICE_WEI = 250_000_000_000_000n;

let transferOk = true;
let n = 0;
const nextTx = () => `0x${(++n).toString(16).padStart(64, "0")}`;

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
      verifyTransfer: vi.fn(async () => (transferOk ? { ok: true, reason: "ok" } : { ok: false, reason: "no" })),
    };
  });
  const mods = {
    quote: await import("@/lib/axonQuote"),
    pay: await import("@/lib/axonPayment"),
    burn: await import("@/lib/axonBurn"),
    payments: await import("@/lib/payments"),
    db: (await import("@/lib/db")).getDb(),
  };
  for (const t of ["axon_quotes", "transactions", "axon_payment_burns", "tasks"]) {
    try { mods.db.prepare(`DELETE FROM ${t}`).run(); } catch { /* not present yet */ }
  }
  for (const id of ["buyer", "worker"]) {
    mods.db
      .prepare(
        `INSERT OR IGNORE INTO agents (agent_id, name, capabilities, public_key, verification_status, created_at, accepts_axon)
         VALUES (?, ?, '[]', ?, 'verified', ?, 1)`,
      )
      .run(id, id, `${id}-key`, new Date().toISOString());
  }
  return mods;
};

describe("splitting a payment", () => {
  it("gives the remainder to the agent, so the parts sum back to what was paid", () => {
    // A number that does not divide cleanly, which is the case that loses a unit if rounded wrongly.
    const paid = 8_755_507_678_171_916_286_773n;
    const s = splitPayment(paid, 1_000);

    expect(s.toAgent + s.toBurn).toBe(paid);
    // Rounding down on the burn means the leftover unit stays with the agent rather than being
    // destroyed. Over enough payments the other direction burns units nobody ever sent.
    expect(s.toBurn).toBe((paid * 1_000n) / BigInt(BPS));
  });

  it("burns nothing at zero, and everything stays with the agent", () => {
    const s = splitPayment(1_000n, 0);
    expect(s.toBurn).toBe(0n);
    expect(s.toAgent).toBe(1_000n);
  });

  it("handles nothing at all", () => {
    expect(splitPayment(0n).toBurn).toBe(0n);
    expect(splitPayment(-5n).paid).toBe(0n);
  });
});

describe("when a burn becomes due", () => {
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

  const paid = async (mods: Awaited<ReturnType<typeof load>>, taskId: string) => {
    const q = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    if (!q.ok) throw new Error("quote failed");
    const res = await mods.pay.createAxonPayment({
      taskId, fromAgent: "buyer", toAgent: "worker", quoteId: q.quote.quoteId, txHash: nextTx(),
    });
    if (!res.ok) throw new Error(`payment failed: ${res.reason}`);
    return { quote: q.quote, payment: res.payment };
  };

  it("is recorded when the payment is escrowed, but is not due yet", async () => {
    const mods = await load();
    const { payment } = await paid(mods, "task-a");

    const ob = mods.burn.obligationFor(payment.txId);
    expect(ob).not.toBeNull();
    expect(ob!.burnUnits).toBeGreaterThan(0n);
    // Escrowed, not earned. Nothing may be burned yet.
    expect(mods.burn.dueBurns()).toHaveLength(0);
    expect(mods.burn.pendingUnits()).toBe(ob!.burnUnits);
  });

  it("becomes due once the task is settled", async () => {
    const mods = await load();
    const { payment } = await paid(mods, "task-b");

    mods.payments.releasePayment("task-b");

    const due = mods.burn.dueBurns();
    expect(due).toHaveLength(1);
    expect(due[0].txId).toBe(payment.txId);
    expect(mods.burn.pendingUnits()).toBe(0n);
  });

  it("never becomes due if the task was refunded", async () => {
    const mods = await load();
    const { payment } = await paid(mods, "task-c");

    mods.payments.refundPayment("task-c");

    // The whole reason the obligation is derived from the payment's status rather than carrying its
    // own. Burning here would take a tenth of the payer's money because their task failed.
    expect(mods.burn.dueBurns()).toHaveLength(0);
    expect(mods.burn.pendingUnits()).toBe(0n);
    expect(mods.burn.burnedUnits()).toBe(0n);
    // And the payer is owed everything they sent, not the escrowed ninety percent.
    expect(mods.pay.refundableUnits(payment.txId)).toBe(
      mods.burn.obligationFor(payment.txId)!.paidUnits,
    );
  });

  it("counts as burned only once it has actually been sent", async () => {
    const mods = await load();
    const { payment } = await paid(mods, "task-d");
    mods.payments.releasePayment("task-d");

    const ob = mods.burn.obligationFor(payment.txId)!;
    expect(mods.burn.burnedUnits()).toBe(0n);

    expect(mods.burn.markBurned(ob.burnId, "0xdead")).toBe(true);

    expect(mods.burn.burnedUnits()).toBe(ob.burnUnits);
    expect(mods.burn.dueBurns()).toHaveLength(0);
  });

  it("cannot be burned twice", async () => {
    const mods = await load();
    const { payment } = await paid(mods, "task-e");
    mods.payments.releasePayment("task-e");
    const ob = mods.burn.obligationFor(payment.txId)!;

    expect(mods.burn.markBurned(ob.burnId, "0xaaa")).toBe(true);
    // A second sweep finding the same row must not send the tokens again.
    expect(mods.burn.markBurned(ob.burnId, "0xbbb")).toBe(false);
    expect(mods.burn.burnedUnits()).toBe(ob.burnUnits);
  });

  it("keeps one obligation per payment", async () => {
    const mods = await load();
    const { payment } = await paid(mods, "task-f");

    expect(() =>
      mods.burn.recordObligation({ txId: payment.txId, paid: 100n, burn: 10n }),
    ).toThrow();
  });
});

describe("the ceiling on the share", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; vi.resetModules(); });

  it("refuses to burn more than a third, whatever the variable says", async () => {
    // 30000 rather than 3000 is the typo basis points invite, and without a ceiling it would burn
    // the agent's entire fee and then some.
    process.env.AXON_PAYMENT_BURN_BPS = "30000";
    vi.resetModules();
    const { BURN_BPS } = await import("@/lib/axonBurn");

    expect(BURN_BPS).toBeLessThanOrEqual(3_333);
  });

  it("falls back to the default when the variable is nonsense", async () => {
    process.env.AXON_PAYMENT_BURN_BPS = "ten percent";
    vi.resetModules();
    const { BURN_BPS } = await import("@/lib/axonBurn");

    expect(BURN_BPS).toBe(1_000);
  });
});
