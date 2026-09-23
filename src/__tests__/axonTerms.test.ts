import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clampDiscount, MAX_AXON_DISCOUNT_BPS } from "@/lib/agents";

/**
 * An agent's own terms.
 *
 * Whether it takes $AXON, and what it charges when it does, belong to the agent rather than to the
 * platform. So the two things worth testing are that nobody is opted in by accident, and that the
 * discount is a dial the agent turns rather than a number the platform applies to everyone.
 */

const AXON = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const RECEIVER = "0x1111111111111111111111111111111111111111";
const SQRT_P = 468867624989588479258801841136883n;
const PRICE_WEI = 250_000_000_000_000n;

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
    return { ...actual, verifyTransfer: vi.fn(async () => ({ ok: true, reason: "ok" })) };
  });
  const mods = {
    quote: await import("@/lib/axonQuote"),
    pay: await import("@/lib/axonPayment"),
    x402: await import("@/lib/x402"),
    db: (await import("@/lib/db")).getDb(),
  };
  for (const t of ["axon_quotes", "transactions", "axon_payment_burns"]) {
    try { mods.db.prepare(`DELETE FROM ${t}`).run(); } catch { /* not present */ }
  }
  return mods;
};

type Db = ReturnType<typeof import("@/lib/db").getDb>;

const seed = (db: Db, id: string, accepts: boolean) => {
  db.prepare("DELETE FROM agents WHERE agent_id = ?").run(id);
  db.prepare(
    `INSERT INTO agents (agent_id, name, capabilities, public_key, verification_status, created_at, accepts_axon)
     VALUES (?, ?, '[]', ?, 'verified', ?, ?)`,
  ).run(id, id, `${id}-key`, new Date().toISOString(), accepts ? 1 : 0);
};

describe("the cap on a discount", () => {
  it("treats a number outside the range as no discount, not as the nearest legal one", () => {
    // 50000 rather than 5000 is the mistake basis points invite. Snapping it to the maximum would
    // turn a typo into a real half-price offer; refusing it leaves the agent charging what it said.
    expect(clampDiscount(50_000)).toBe(0);
    expect(clampDiscount(-100)).toBe(0);
    expect(clampDiscount(12.5)).toBe(0);
    // A numeric string is leniency rather than nonsense: these arrive as JSON, and "2000" plainly
    // means two thousand. What is refused is a number that cannot mean what it says.
    expect(clampDiscount("2000")).toBe(2_000);
  });

  it("allows anything up to half", () => {
    expect(clampDiscount(1_000)).toBe(1_000);
    expect(clampDiscount(MAX_AXON_DISCOUNT_BPS)).toBe(MAX_AXON_DISCOUNT_BPS);
    expect(clampDiscount(MAX_AXON_DISCOUNT_BPS + 1)).toBe(0);
  });
});

describe("opting in", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = RECEIVER;
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  const REQ = { resource: "https://axon-agents.com/r", price: "0.00025 ETH", description: "a task" };

  it("offers no token option for an agent that has not opted in", async () => {
    const mods = await load();
    const req = await mods.x402.buildX402RequirementsWithAxon({ ...REQ, axon: { acceptsAxon: false } });

    // Quoting a currency an owner never agreed to would be committing them to take it.
    expect(req?.accepts).toHaveLength(1);
    expect(req?.accepts[0].asset).toBe("ETH");
  });

  it("offers it once the agent has", async () => {
    const mods = await load();
    const req = await mods.x402.buildX402RequirementsWithAxon({ ...REQ, axon: { acceptsAxon: true } });

    expect(req?.accepts).toHaveLength(2);
    expect(req?.accepts[1].asset).toBe(AXON);
  });

  it("refuses to escrow a token payment for an agent that has not opted in", async () => {
    const mods = await load();
    seed(mods.db, "buyer", true);
    seed(mods.db, "unwilling", false);

    const q = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    if (!q.ok) throw new Error("quote failed");
    const res = await mods.pay.createAxonPayment({
      taskId: "t", fromAgent: "buyer", toAgent: "unwilling", quoteId: q.quote.quoteId, txHash: nextTx(),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("agent-does-not-accept-axon");
  });
});

describe("the discount an agent sets", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = RECEIVER;
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("makes the token cheaper than the ETH price, by exactly what was set", async () => {
    const mods = await load();

    const full = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    const cut = await mods.quote.createQuote({ ethWei: PRICE_WEI, discountBps: 2_000 });
    if (!full.ok || !cut.ok) throw new Error("quote failed");

    // Twenty percent off, applied to the debt before conversion rather than to the token amount
    // after, so the stored eth_wei is what the payer actually owes.
    expect(cut.quote.ethWei).toBe((PRICE_WEI * 8_000n) / 10_000n);
    expect(cut.quote.axonUnits).toBeLessThan(full.quote.axonUnits);
    // Eighty percent of the tokens, give or take the unit that integer division drops.
    const expected = (full.quote.axonUnits * 8_000n) / 10_000n;
    const drift = cut.quote.axonUnits > expected ? cut.quote.axonUnits - expected : expected - cut.quote.axonUnits;
    expect(drift).toBeLessThan(1_000_000n);
  });

  it("ignores a nonsense discount rather than honouring it", async () => {
    const mods = await load();

    const full = await mods.quote.createQuote({ ethWei: PRICE_WEI });
    const silly = await mods.quote.createQuote({ ethWei: PRICE_WEI, discountBps: 90_000 });
    if (!full.ok || !silly.ok) throw new Error("quote failed");

    expect(silly.quote.ethWei).toBe(full.quote.ethWei);
  });

  it("does not share a quote between two agents on different terms", async () => {
    const mods = await load();
    const REQ = { resource: "https://axon-agents.com/r", price: "0.00025 ETH", description: "a task" };

    const cheap = await mods.x402.buildX402RequirementsWithAxon({
      ...REQ, axon: { acceptsAxon: true, axonDiscountBps: 2_000 },
    });
    const full = await mods.x402.buildX402RequirementsWithAxon({
      ...REQ, axon: { acceptsAxon: true, axonDiscountBps: 0 },
    });

    // Same resource and same listed price, different terms. Sharing one quote would hand one agent
    // the other's price.
    expect(cheap?.accepts[1].extra.quoteId).not.toBe(full?.accepts[1].extra.quoteId);
    expect(BigInt(cheap!.accepts[1].maxAmountRequired)).toBeLessThan(
      BigInt(full!.accepts[1].maxAmountRequired),
    );
  });
});
