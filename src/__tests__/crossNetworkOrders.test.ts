// My Hires / My Buys — the per-wallet record of cross-network orders. Contracts:
// hires/buys persist keyed by wallet, kinds map to the right status, recording is
// idempotent on the tx signature (a retried write never duplicates), hostile
// input is rejected, and listing is scoped to the asking wallet only.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { recordOrder, listOrders, getOrderByTxSig } from "@/lib/crossNetworkOrders";
import { GET as ordersGET, POST as ordersPOST } from "@/app/api/agenc/orders/route";

const WALLET_A = "11111111111111111111111111111111";

let n = 0;
// unique, valid base58 signatures: map each decimal digit to a distinct letter
// (a bijection, so distinct counters → distinct strings), pad left with 'a'.
const sig = () =>
  "sig" + (n++).toString().split("").map((d) => "abcdefghij"[Number(d)]).join("").padStart(85, "a");

describe("recordOrder", () => {
  it("records a hire as 'funded' and a buy as 'settled'", () => {
    const hire = recordOrder({ wallet: WALLET_A, kind: "hire", itemPda: "TaskPda1", name: "Research Agent", price: "0.02 SOL", txSig: sig() });
    const buy = recordOrder({ wallet: WALLET_A, kind: "buy", itemPda: "GoodPda1", name: "Stone ×100", price: "0.002 SOL", txSig: sig() });
    expect(hire?.kind).toBe("hire");
    expect(hire?.status).toBe("funded");
    expect(hire?.network).toBe("agenc");
    expect(buy?.status).toBe("settled");
  });

  it("is idempotent on the tx signature — a retried write never duplicates", () => {
    const s = sig();
    const first = recordOrder({ wallet: WALLET_A, kind: "buy", itemPda: "GoodPda2", name: "Fiber", price: "0.001 SOL", txSig: s });
    const again = recordOrder({ wallet: WALLET_A, kind: "buy", itemPda: "GoodPda2", name: "Fiber", price: "0.001 SOL", txSig: s });
    expect(first?.id).toBe(again?.id); // same row, not a second insert
    expect(getOrderByTxSig(s)?.id).toBe(first?.id);
  });

  it("rejects invalid input: bad wallet, unknown kind, missing ids", () => {
    expect(recordOrder({ wallet: "not-a-wallet", kind: "buy", itemPda: "G", name: "x", price: "1", txSig: sig() })).toBeNull();
    expect(recordOrder({ wallet: WALLET_A, kind: "gift", itemPda: "G", name: "x", price: "1", txSig: sig() })).toBeNull();
    expect(recordOrder({ wallet: WALLET_A, kind: "buy", itemPda: "", name: "x", price: "1", txSig: sig() })).toBeNull();
    expect(recordOrder({ wallet: WALLET_A, kind: "buy", itemPda: "G", name: "x", price: "1", txSig: "" })).toBeNull();
    // the tx sig is the on-chain anchor rendered into a solscan URL — reject
    // anything that isn't a real base58 signature
    expect(recordOrder({ wallet: WALLET_A, kind: "buy", itemPda: "G", name: "x", price: "1", txSig: "not a sig!!" })).toBeNull();
    expect(recordOrder({ wallet: WALLET_A, kind: "buy", itemPda: "G", name: "x", price: "1", txSig: "0OIl".repeat(20) })).toBeNull(); // non-base58 chars
    expect(recordOrder({ wallet: WALLET_A, kind: "buy", itemPda: "G", name: "x", price: "1", txSig: "abc" })).toBeNull(); // too short
  });

  it("defaults a missing name/price rather than storing empty", () => {
    const o = recordOrder({ wallet: WALLET_A, kind: "hire", itemPda: "TaskPda9", name: "", price: "", txSig: sig() });
    expect(o?.name).toBe("(unnamed)");
    expect(o?.price).toBe("—");
  });

  it("caps oversized strings so a hostile client can't stuff the table", () => {
    const o = recordOrder({ wallet: WALLET_A, kind: "buy", itemPda: "G".repeat(500), name: "N".repeat(500), price: "P".repeat(500), txSig: sig() });
    expect(o).not.toBeNull();
    expect(o!.name.length).toBeLessThanOrEqual(80);
    expect(o!.itemPda.length).toBeLessThanOrEqual(64);
    expect(o!.price.length).toBeLessThanOrEqual(40);
  });
});

describe("listOrders", () => {
  it("returns only the asking wallet's orders, newest first", () => {
    const wA = "Awa11111111111111111111111111111111111111111";
    const wB = "Bwb11111111111111111111111111111111111111111";
    recordOrder({ wallet: wA, kind: "buy", itemPda: "gA1", name: "A-first", price: "1", txSig: sig() });
    recordOrder({ wallet: wB, kind: "buy", itemPda: "gB1", name: "B-only", price: "1", txSig: sig() });
    recordOrder({ wallet: wA, kind: "hire", itemPda: "gA2", name: "A-second", price: "1", txSig: sig() });

    const a = listOrders(wA);
    expect(a.length).toBe(2);
    expect(a.every((o) => o.wallet === wA)).toBe(true); // never leaks another wallet's history
    expect(a[0].name).toBe("A-second"); // newest first
    expect(listOrders(wB).map((o) => o.name)).toEqual(["B-only"]);
  });

  it("returns [] for an invalid wallet", () => {
    expect(listOrders("garbage")).toEqual([]);
  });
});

describe("/api/agenc/orders route", () => {
  const wallet = "Rte11111111111111111111111111111111111111111";

  it("POST records then GET returns it for that wallet", async () => {
    const post = await ordersPOST(
      new NextRequest("http://localhost/api/agenc/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, kind: "buy", itemPda: "RteGood1", name: "Sword (T1)", price: "0.01 SOL", txSig: `route${"1".repeat(80)}` }),
      }),
    );
    expect(post.status).toBe(201);

    const get = await ordersGET(new NextRequest(`http://localhost/api/agenc/orders?wallet=${wallet}`, { method: "GET" }));
    expect(get.status).toBe(200);
    const body = (await get.json()) as { orders: { name: string; kind: string }[] };
    expect(body.orders.some((o) => o.name === "Sword (T1)" && o.kind === "buy")).toBe(true);
  });

  it("POST with junk returns 400; GET without a wallet returns 400", async () => {
    const bad = await ordersPOST(
      new NextRequest("http://localhost/api/agenc/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: "nope", kind: "buy" }),
      }),
    );
    expect(bad.status).toBe(400);
    const noWallet = await ordersGET(new NextRequest("http://localhost/api/agenc/orders", { method: "GET" }));
    expect(noWallet.status).toBe(400);
  });
});
