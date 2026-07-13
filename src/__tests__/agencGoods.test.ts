// AgenC goods discovery normalization. The buy tx itself is composed against the
// live AgenC program (verified end-to-end on deployed private, like hire-through);
// here we lock the pure feed-normalization + price logic that must never throw on
// a hostile/partial feed and must render SOL vs USDC correctly.

import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => vi.restoreAllMocks());

async function goodsFrom(items: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 })));
  // fresh import each call so the 5-min module cache doesn't bleed between cases
  vi.resetModules();
  const { getAgencGoods } = await import("@/lib/integrations/agencGoods");
  return getAgencGoods();
}

const base = {
  pda: "74CBNEUNQCTvqXgujjN35A6duWjVTaJxePHsruYDkhjA",
  name: "Canary First Sale",
  sellerAgent: "3cZeUpRdhDhmRSRHFqm96Hw2gRpgtXFxUtoVARnS6gZN",
  priceLamports: "2000000",
  priceMint: null,
  totalSupply: "3",
  soldCount: "1",
  remainingSupply: "2",
  isActive: true,
  metadata: { state: "verified", displayName: "Canary", longDescription: "first good", category: "collectible" },
};

describe("getAgencGoods normalization", () => {
  it("normalizes a good and renders a SOL price", async () => {
    const [g] = await goodsFrom([base]);
    expect(g.id).toBe(base.pda);
    expect(g.name).toBe("Canary First Sale");
    expect(g.price).toBe("0.002"); // 2_000_000 lamports
    expect(g.currency).toBe("SOL");
    expect(g.remaining).toBe(2);
    expect(g.verified).toBe(true);
  });

  it("includes SOL + USDC goods (with or without an operator leg), excludes other mints", async () => {
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const goods = await goodsFrom([
      { ...base, pda: "UsdcGood1", priceMint: USDC }, // USDC-priced → KEPT
      { ...base, pda: "UsdcOpGood", priceMint: USDC, operator: "Op111111111111111111111111111111111111111111" }, // USDC + operator → KEPT
      { ...base, pda: "SolOpGood", operator: "Op111111111111111111111111111111111111111111" }, // SOL + operator → KEPT
      { ...base, pda: "OtherMint", priceMint: "So11111111111111111111111111111111111111112" }, // non-USDC mint → EXCLUDED
      base, // SOL, no operator → KEPT
    ]);
    const ids = goods.map((g) => g.id);
    expect(ids).toContain("UsdcGood1");
    expect(ids).toContain("UsdcOpGood");
    expect(ids).toContain("SolOpGood"); // operator-leg goods are now composable
    expect(ids).not.toContain("OtherMint"); // unknown mint: can't price/fulfil honestly
    expect(ids).toContain(base.pda);
    // USDC goods render a USDC price (2_000_000 base units ÷ 1e6).
    expect(goods.find((g) => g.id === "UsdcGood1")?.currency).toBe("USDC");
    expect(goods.find((g) => g.id === "UsdcGood1")?.price).toBe("2");
  });

  it("keeps sold-out items (in-stock first) and never throws on malformed rows", async () => {
    const goods = await goodsFrom([
      { ...base, pda: "SoldOut1", remainingSupply: "0", totalSupply: "1", soldCount: "1" },
      { pda: 12345, name: null }, // hostile row — must not throw
      base,
    ]);
    const ids = goods.map((g) => g.id);
    // Sold-out goods are kept so the section persists + shows a real completed sale…
    expect(ids).toContain("SoldOut1");
    expect(goods.find((g) => g.id === "SoldOut1")?.remaining).toBe(0);
    // …but in-stock sorts ahead of sold-out.
    expect(ids[0]).toBe(base.pda);
    expect(goods.every((g) => g.id && g.name)).toBe(true);
  });

  it("fails soft to [] when the feed errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 502 })));
    vi.resetModules();
    const { getAgencGoods } = await import("@/lib/integrations/agencGoods");
    expect(await getAgencGoods()).toEqual([]);
  });
});
