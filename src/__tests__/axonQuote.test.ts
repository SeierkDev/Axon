import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "@/lib/db";
import { axonForWei } from "@/lib/axonPool";

/**
 * A quote is a promise about a number that moves.
 *
 * The agent prices in ETH, the payer sends $AXON, and the rate between them is whatever the pool says
 * at that instant. Almost every test here is about one consequence of that: the number a payer is
 * shown has to be the number they are held to, even though the world changes between the two.
 */

const AXON = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const RECEIVER = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}`;

// The live pool at the time of writing, so the numbers in these tests are the real order of magnitude.
const SQRT_P = 468867624989588479258801841136883n;

let transferOk = true;
// Mutable, so a test can move the price without resetting the module registry. Resetting would also
// hand the module a fresh database, and a deviation check has nothing to compare against then.
let sqrtNow: bigint | null = SQRT_P;

const load = async () => {
  vi.resetModules();
  vi.doMock("@/lib/axonPool", async () => {
    const actual = await vi.importActual<typeof import("@/lib/axonPool")>("@/lib/axonPool");
    return {
      ...actual,
      readPoolPrice: vi.fn(async () =>
        sqrtNow === null ? null : { sqrtPriceX96: sqrtNow, axonPerEth: Number(actual.axonForWei(10n ** 18n, sqrtNow)) / 1e18 },
      ),
    };
  });
  vi.doMock("@/lib/evm", async () => {
    const actual = await vi.importActual<typeof import("@/lib/evm")>("@/lib/evm");
    return {
      ...actual,
      verifyTransfer: vi.fn(async () => (transferOk ? { ok: true, reason: "ok" } : { ok: false, reason: "no token transfer" })),
    };
  });
  return import("@/lib/axonQuote");
};

describe("quoting a job in $AXON", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    getDb().prepare("DELETE FROM axon_quotes").run();
    transferOk = true;
    sqrtNow = SQRT_P;
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = RECEIVER;
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("refuses to quote at all until settlement is deliberately switched on", async () => {
    delete process.env.AXON_SETTLEMENT_TOKEN_ADDRESS;
    const { createQuote } = await load();

    const r = await createQuote({ ethWei: 250_000_000_000_000n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("settlement-disabled");
  });

  it("prices a real listed job against the pool", async () => {
    const { createQuote } = await load();

    // 0.00025 ETH is a price agents actually list at.
    const r = await createQuote({ ethWei: 250_000_000_000_000n });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.quote.axonUnits).toBe(axonForWei(250_000_000_000_000n, SQRT_P));
    expect(r.quote.payTo).toBe(RECEIVER);
    expect(r.quote.axonUnits).toBeGreaterThan(0n);
  });

  it("refuses dust", async () => {
    const { createQuote } = await load();
    const r = await createQuote({ ethWei: 1_000n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("below-minimum");
  });

  it("gives a retried request the quote it already made", async () => {
    const { createQuote } = await load();

    const a = await createQuote({ ethWei: 250_000_000_000_000n, idempotencyKey: "hire-42" });
    const b = await createQuote({ ethWei: 250_000_000_000_000n, idempotencyKey: "hire-42" });

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Two live quotes for one request would let a caller pay whichever moved in its favour.
    expect(b.quote.quoteId).toBe(a.quote.quoteId);
    expect(b.quote.axonUnits).toBe(a.quote.axonUnits);
  });

  it("holds the payer to the quoted amount, not to a fresh one", async () => {
    const mod = await load();

    const issued = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const pinned = issued.quote.axonUnits;

    const settled = await mod.settleQuote({ quoteId: issued.quote.quoteId, txHash: TX, payer: PAYER });
    expect(settled.ok).toBe(true);

    // The stored amount is untouched by anything the pool did in between. This is the whole reason
    // quotes are written down: a payer who sent exactly what they were shown must not be refused
    // because the price moved while their transaction sat in a block.
    const after = mod.getQuote(issued.quote.quoteId);
    expect(after?.axonUnits).toBe(pinned);
    expect(after?.txHash).toBe(TX);
  });

  it("refuses an expired quote before it touches the chain", async () => {
    const mod = await load();
    const issued = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    if (!issued.ok) throw new Error("quote failed");

    const later = new Date(Date.now() + (mod.QUOTE_TTL_SECONDS + 60) * 1000);
    const r = await mod.settleQuote({ quoteId: issued.quote.quoteId, txHash: TX, now: later });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("treats the same transaction replayed as a retry, not a second payment", async () => {
    const mod = await load();
    const issued = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    if (!issued.ok) throw new Error("quote failed");

    const first = await mod.settleQuote({ quoteId: issued.quote.quoteId, txHash: TX });
    const again = await mod.settleQuote({ quoteId: issued.quote.quoteId, txHash: TX });

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
  });

  it("will not let one transaction settle two quotes", async () => {
    const mod = await load();
    const a = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    const b = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    if (!a.ok || !b.ok) throw new Error("quote failed");

    await mod.settleQuote({ quoteId: a.quote.quoteId, txHash: TX });
    const second = await mod.settleQuote({ quoteId: b.quote.quoteId, txHash: TX });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("tx-already-used");
  });

  it("does not mark a quote paid when the transfer was not there", async () => {
    const mod = await load();
    const issued = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    if (!issued.ok) throw new Error("quote failed");

    transferOk = false;
    const r = await mod.settleQuote({ quoteId: issued.quote.quoteId, txHash: TX });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transfer-rejected");
    expect(mod.getQuote(issued.quote.quoteId)?.consumedAt).toBeNull();
  });

  it("does not lock the token out forever once the price has moved", async () => {
    // The guard used to eat itself. Its reference is the last quote ever issued, and a refused
    // quote is never written, so once the price sat beyond the deviation nothing could be quoted,
    // the reference could never move, and nothing could be quoted again. The $AXON option did not
    // pause, it disappeared until somebody wrote a row by hand.
    const mod = await load();
    const first = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    expect(first.ok).toBe(true);

    // The price moves far, and the only quote on record is now old enough to be history.
    sqrtNow = (SQRT_P * 3n) / 2n;
    // The database has to be the one the module under test is holding. vi.resetModules() hands the
    // module a fresh registry, so the getDb imported at the top of this file is a different
    // instance writing somewhere else entirely, and the update would land nowhere useful.
    const db = (await import("@/lib/db")).getDb();
    db.prepare("UPDATE axon_quotes SET created_at = ?")
      .run(new Date(Date.now() - (mod.REFERENCE_MAX_AGE_SECONDS + 60) * 1000).toISOString());

    const later = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    expect(later.ok).toBe(true);

    // And the new quote becomes the reference, so the guard is armed again straight away.
    sqrtNow = (SQRT_P * 3n) / 2n * 3n / 2n;
    const flash = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    expect(flash.ok).toBe(false);
    if (!flash.ok) expect(flash.reason).toBe("rate-moved");
  });

  it("refuses to quote through a sudden move in a thin pool", async () => {
    const mod = await load();
    const first = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    expect(first.ok).toBe(true);

    // The sqrt price is the square root of the price, so a 50% jump here is roughly a doubling.
    sqrtNow = (SQRT_P * 3n) / 2n;

    const r = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rate-moved");
  });

  it("says there is no price rather than inventing one", async () => {
    const mod = await load();
    // Before graduation, between graduation and pool creation, or after a rescue, there is no pool.
    sqrtNow = null;

    const r = await mod.createQuote({ ethWei: 250_000_000_000_000n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-price");
  });
});

describe("the conversion itself", () => {
  it("matches the pool's own arithmetic at the live price", () => {
    // One ETH at the price the pool held while this was written.
    const perEth = axonForWei(10n ** 18n, SQRT_P);
    expect(Number(perEth) / 1e18).toBeGreaterThan(30_000_000);
    expect(Number(perEth) / 1e18).toBeLessThan(40_000_000);
  });

  it("scales exactly, with no float anywhere in the path", () => {
    const one = axonForWei(10n ** 18n, SQRT_P);
    const tenth = axonForWei(10n ** 17n, SQRT_P);
    // Exact to the unit, which a float would not be.
    expect(one / 10n - tenth).toBeLessThanOrEqual(1n);
  });

  it("returns nothing for nothing", () => {
    expect(axonForWei(0n, SQRT_P)).toBe(0n);
    expect(axonForWei(10n ** 18n, 0n)).toBe(0n);
  });
});
