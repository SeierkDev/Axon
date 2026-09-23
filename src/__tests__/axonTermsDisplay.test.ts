import { describe, it, expect } from "vitest";
import { axonTerms, clampDiscount, MAX_AXON_DISCOUNT_BPS } from "@/lib/axonTerms";

/**
 * What the site tells a person about paying in $AXON.
 *
 * The payment side worked before any of this existed, and was invisible: an agent could read the
 * terms off a 402 response, and a human reading the website could not learn that the token buys
 * agent work at all. This is that gap closed, so what is tested here is not layout.
 *
 * It is that the listing never advertises terms the payment side will not honour. A badge is a
 * claim about what somebody will be charged, and the stored terms are what actually charges them.
 */

const agent = (over: Partial<Parameters<typeof axonTerms>[0]> = {}) => ({
  acceptsAxon: true,
  axonDiscountBps: 2_000,
  price: "0.00025 ETH",
  ...over,
});

describe("what the badge says", () => {
  it("shows the discount an agent set", () => {
    const terms = axonTerms(agent());
    expect(terms?.discount).toBe("20%");
    expect(terms?.short).toBe("$AXON 20% off");
  });

  it("says so plainly when the agent takes $AXON at full price", () => {
    // Opting in without a discount is a real choice and still worth saying: it is one more agent
    // the token can be spent on.
    const terms = axonTerms(agent({ axonDiscountBps: 0 }));
    expect(terms?.discountBps).toBe(0);
    expect(terms?.short).toBe("Pays in $AXON");
    expect(terms?.long).not.toMatch(/off/);
  });

  it("writes a fractional discount without a trailing zero", () => {
    expect(axonTerms(agent({ axonDiscountBps: 1_250 }))?.discount).toBe("12.5%");
    expect(axonTerms(agent({ axonDiscountBps: 500 }))?.discount).toBe("5%");
  });
});

describe("when there is nothing to say", () => {
  it("says nothing for an agent that has not opted in", () => {
    expect(axonTerms(agent({ acceptsAxon: false }))).toBeNull();
    expect(axonTerms(agent({ acceptsAxon: undefined }))).toBeNull();
  });

  it("says nothing on a free agent", () => {
    // A discount off nothing is nothing, and a badge offering to take payment for an unpaid task
    // is a worse listing than no badge.
    expect(axonTerms(agent({ price: "" }))).toBeNull();
    expect(axonTerms(agent({ price: undefined }))).toBeNull();
    expect(axonTerms(agent({ price: "   " }))).toBeNull();
  });
});

describe("the site cannot advertise terms the agent's own settings refuse", () => {
  it("treats an out-of-range discount as none at all, exactly as the stored terms do", () => {
    // Not the nearest legal value. 50000 rather than 5000 is the mistake basis points invite, and
    // snapping it down would turn a typo into a real half-price offer on a public listing.
    for (const bps of [50_000, 9_000, MAX_AXON_DISCOUNT_BPS + 1, -100, 12.5]) {
      expect(clampDiscount(bps)).toBe(0);
      expect(axonTerms(agent({ axonDiscountBps: bps }))?.discountBps).toBe(0);
      expect(axonTerms(agent({ axonDiscountBps: bps }))?.short).toBe("Pays in $AXON");
    }
  });

  it("agrees with the stored terms across the whole legal range", () => {
    for (const bps of [1, 250, 1_000, 2_000, 3_333, MAX_AXON_DISCOUNT_BPS]) {
      expect(axonTerms(agent({ axonDiscountBps: bps }))?.discountBps).toBe(clampDiscount(bps));
    }
  });

  it("renders nothing for a discount that is not a number", () => {
    for (const bps of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(axonTerms(agent({ axonDiscountBps: bps }))?.discountBps).toBe(0);
    }
  });
});

describe("an owner turning it on actually reaches the listing", () => {
  it("goes from stored row to badge without losing the terms on the way", async () => {
    const { getDb } = await import("@/lib/db");
    const { updateAgent, getAgentById } = await import("@/lib/agents");
    const db = getDb();

    db.prepare("DELETE FROM agents WHERE agent_id = ?").run("optin");
    db.prepare(
      `INSERT INTO agents (agent_id, name, capabilities, public_key, verification_status, created_at, price)
       VALUES ('optin', 'Opt In Agent', '["research"]', 'k', 'verified', ?, '0.00025 ETH')`,
    ).run(new Date().toISOString());

    // Off by default. This is the state every agent on the network starts in, and the state the
    // whole feature sat in until an owner could change it.
    expect(axonTerms(getAgentById("optin")!)).toBeNull();

    updateAgent("optin", { acceptsAxon: true, axonDiscountBps: 2_000 });

    const terms = axonTerms(getAgentById("optin")!);
    expect(terms?.short).toBe("$AXON 20% off");

    // And back off again, because an owner who changes their mind must be able to.
    updateAgent("optin", { acceptsAxon: false });
    expect(axonTerms(getAgentById("optin")!)).toBeNull();
  });
});
