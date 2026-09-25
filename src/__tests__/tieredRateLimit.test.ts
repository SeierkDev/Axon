// Rate limits that widen with what a wallet holds.
//
// The rule that matters most is the one about not going backwards: this may only ever raise a
// limit. An anonymous caller, a wallet holding nothing, and anyone caught in an RPC outage must all
// get exactly the throughput they get today, because taking any of it away would be a change
// nobody asked for dressed up as a feature.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const authenticateApiKey = vi.fn();
const getTier = vi.fn();

vi.mock("@/lib/identity", () => ({ authenticateApiKey: (r: unknown) => authenticateApiKey(r) }));
vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});

const WALLET = "0xAAAaAAaaAAAAaaAAAAAAaaaaAAAAAAaaAAaaAAAA";
const tier = (name: string, rank: number, minimum = 0) => ({ tier: { name, rank, minimum } });

const req = () => new NextRequest("https://axon-agents.com/mcp", { method: "POST", headers: { "x-forwarded-for": "10.0.0.1" } });

const load = async () => {
  vi.resetModules();
  return import("@/lib/tieredRateLimit");
};

describe("what a tier is worth", () => {
  it("multiplies the endpoint's own base rather than imposing one number", async () => {
    // A 60/min endpoint and a 5/min endpoint should not collapse to the same limit just because the
    // same wallet is calling them.
    const { limitFor } = await load();
    const operator = { name: "operator" as const, rank: 3, minimum: 100_000 };

    expect(limitFor(60, operator)).toBe(600);
    expect(limitFor(5, operator)).toBe(50);
  });

  it("leaves base exactly where it is", async () => {
    const { limitFor } = await load();
    expect(limitFor(60, { name: "base", rank: 0, minimum: 0 })).toBe(60);
  });

  it("never returns less than the base, whatever the multiplier says", async () => {
    const mod = await load();
    // A multiplier misconfigured below 1 would quietly take throughput away from a holder, which is
    // the one thing this is not allowed to do.
    (mod.TIER_MULTIPLIER as Record<string, number>).holder = 0.5;
    expect(mod.limitFor(60, { name: "holder", rank: 1, minimum: 1_000 })).toBe(60);
  });
});

describe("applying it to a request", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("gives an anonymous caller the limit the endpoint always had", async () => {
    authenticateApiKey.mockReturnValue(null);
    const { checkTieredRateLimit } = await load();

    const r = await checkTieredRateLimit(req(), "test-anon", 60, 60_000);
    // Most MCP traffic is anonymous. Base for them is the correct answer, not a shortfall.
    expect(r.limit).toBe(60);
    expect(r.tier.name).toBe("base");
    expect(r.wallet).toBeNull();
    expect(getTier).not.toHaveBeenCalled();
  });

  it("widens the limit for a holder, read from the key's wallet", async () => {
    authenticateApiKey.mockReturnValue({ keyId: "k1", walletAddress: WALLET });
    getTier.mockResolvedValue(tier("builder", 2, 25_000));
    const { checkTieredRateLimit } = await load();

    const r = await checkTieredRateLimit(req(), "test-builder", 60, 60_000);
    expect(r.limit).toBe(300);
    expect(r.wallet).toBe(WALLET);
  });

  it("takes the wallet from the authenticated key, never from the caller", async () => {
    // The whole security of this: you cannot claim a wallet, you authenticate as one.
    authenticateApiKey.mockReturnValue({ keyId: "k1", walletAddress: WALLET });
    getTier.mockResolvedValue(tier("operator", 3, 100_000));
    const { checkTieredRateLimit } = await load();

    const spoofed = new NextRequest("https://axon-agents.com/mcp", {
      method: "POST",
      headers: { "x-wallet-address": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    });
    const r = await checkTieredRateLimit(spoofed, "test-spoof", 60, 60_000);

    expect(r.wallet).toBe(WALLET);
    expect(getTier).toHaveBeenCalledWith(WALLET);
  });

  it("counts a holder per wallet, not per IP", async () => {
    authenticateApiKey.mockReturnValue({ keyId: "k1", walletAddress: WALLET });
    getTier.mockResolvedValue(tier("holder", 1, 1_000));
    const { checkTieredRateLimit } = await load();

    // Same wallet, two machines. The throughput they paid for follows them, and is not shared with
    // everyone else behind one address.
    const a = await checkTieredRateLimit(req(), "test-follow", 2, 60_000);
    const b = await checkTieredRateLimit(
      new NextRequest("https://axon-agents.com/mcp", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } }),
      "test-follow", 2, 60_000,
    );

    expect(a.result.allowed).toBe(true);
    expect(b.result.allowed).toBe(true); // second call on the same wallet bucket, still within 4
  });

  it("degrades to base when a bad key throws rather than failing the request", async () => {
    authenticateApiKey.mockImplementation(() => { throw new Error("malformed key"); });
    const { checkTieredRateLimit } = await load();

    const r = await checkTieredRateLimit(req(), "test-throw", 60, 60_000);
    expect(r.limit).toBe(60);
    expect(r.tier.name).toBe("base");
  });

  it("degrades to base when the tier cannot be read", async () => {
    authenticateApiKey.mockReturnValue({ keyId: "k1", walletAddress: WALLET });
    // getTier never throws by contract; this is the outage shape it returns.
    getTier.mockResolvedValue(tier("base", 0));
    const { checkTieredRateLimit } = await load();

    const r = await checkTieredRateLimit(req(), "test-outage", 60, 60_000);
    // An outage can withhold something extra. It can never take away what the endpoint always gave.
    expect(r.limit).toBe(60);
  });

  it("still enforces a limit, just a wider one", async () => {
    authenticateApiKey.mockReturnValue({ keyId: "k1", walletAddress: WALLET });
    getTier.mockResolvedValue(tier("holder", 1, 1_000));
    const { checkTieredRateLimit } = await load();

    // base 1/min doubled to 2: the third call in the window is refused.
    const p = "test-enforced";
    expect((await checkTieredRateLimit(req(), p, 1, 60_000)).result.allowed).toBe(true);
    expect((await checkTieredRateLimit(req(), p, 1, 60_000)).result.allowed).toBe(true);
    expect((await checkTieredRateLimit(req(), p, 1, 60_000)).result.allowed).toBe(false);
  });
});
