// Reclaim — the safety layer on cross-network hires. The critical invariant:
// an escrow is reclaimable IF AND ONLY IF the work is still undelivered. A
// delivered/in-review/reclaimed/disputed hire must never be reclaimable, or a
// buyer could yank the escrow out from under a worker who did the job.

import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { toDelivery } from "@/lib/integrations/agencReclaim";
import * as reclaimLib from "@/lib/integrations/agencReclaim";
import { recordOrder, setOrderStatus } from "@/lib/crossNetworkOrders";
import { GET as statusGET, POST as reclaimPOST, PATCH as reclaimPATCH } from "@/app/api/agenc/reclaim/route";

afterEach(() => vi.restoreAllMocks());

// A valid base58 task PDA for route tests (the route validates format).
const TASK_PDA = "9CTQntJ9YkHwpbxX9UGow8ohjkYrrU5vg7WwGozfdniQ";
const TASK_PDA2 = "5dbeFriiRN8mKmkfhGyV8U1ahMUJq43R98YatVpLvLH9";

// TaskStatus on-chain: Open=0, InProgress=1, PendingValidation=2, Completed=3,
// Cancelled=4, Disputed=5, RejectFrozen=6.
describe("toDelivery — reclaimable ⟺ undelivered", () => {
  it("Open / InProgress are reclaimable (the worker hasn't delivered)", () => {
    expect(toDelivery(0)).toEqual({ state: "awaiting", reclaimable: true, onChainStatus: 0 });
    expect(toDelivery(1)).toEqual({ state: "awaiting", reclaimable: true, onChainStatus: 1 });
  });
  it("delivered / in-review / reclaimed / disputed are NEVER reclaimable", () => {
    expect(toDelivery(2)).toMatchObject({ state: "in_review", reclaimable: false });
    expect(toDelivery(3)).toMatchObject({ state: "delivered", reclaimable: false });
    expect(toDelivery(4)).toMatchObject({ state: "reclaimed", reclaimable: false });
    expect(toDelivery(5)).toMatchObject({ state: "disputed", reclaimable: false });
    expect(toDelivery(6)).toMatchObject({ state: "disputed", reclaimable: false });
  });
  it("a missing/unknown account is 'gone', not reclaimable", () => {
    expect(toDelivery(null)).toEqual({ state: "gone", reclaimable: false, onChainStatus: null });
    expect(toDelivery(99)).toMatchObject({ state: "gone", reclaimable: false });
  });
});

const WALLET = "So11111111111111111111111111111111111111112";
let n = 0;
const sig = () => "rc" + (n++).toString().split("").map((d) => "abcdefghij"[Number(d)]).join("").padStart(84, "a");

describe("setOrderStatus", () => {
  it("flips a funded hire to reclaimed, scoped to (wallet, item)", () => {
    recordOrder({ wallet: WALLET, kind: "hire", itemPda: "TaskRc1", name: "Research Agent", price: "0.02 SOL", txSig: sig() });
    const updated = setOrderStatus(WALLET, "TaskRc1", "reclaimed");
    expect(updated?.status).toBe("reclaimed");
    expect(updated?.wallet).toBe(WALLET);
  });
  it("never touches another wallet's order", () => {
    const other = "Awa11111111111111111111111111111111111111111";
    recordOrder({ wallet: other, kind: "hire", itemPda: "TaskRc2", name: "x", price: "1", txSig: sig() });
    expect(setOrderStatus(WALLET, "TaskRc2", "reclaimed")).toBeNull(); // not our order
  });
  it("rejects invalid wallet / missing item / empty status", () => {
    expect(setOrderStatus("garbage", "TaskRc1", "reclaimed")).toBeNull();
    expect(setOrderStatus(WALLET, "", "reclaimed")).toBeNull();
    expect(setOrderStatus(WALLET, "TaskRc1", "")).toBeNull();
  });
});

describe("/api/agenc/reclaim route validation", () => {
  it("GET without a valid taskPda → 400", async () => {
    const res = await statusGET(new NextRequest("http://localhost/api/agenc/reclaim?taskPda=nope", { method: "GET" }));
    expect(res.status).toBe(400);
  });
  it("POST with junk taskPda/wallet → 400 (before any RPC)", async () => {
    const res = await reclaimPOST(new NextRequest("http://localhost/api/agenc/reclaim", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskPda: "x", buyerPubkey: "y" }),
    }));
    expect(res.status).toBe(400);
  });
  it("PATCH records reclaimed ONLY when the chain confirms it cancelled", async () => {
    const w = "Bwb11111111111111111111111111111111111111111";
    recordOrder({ wallet: w, kind: "hire", itemPda: TASK_PDA, name: "Agent", price: "0.01 SOL", txSig: sig() });
    vi.spyOn(reclaimLib, "getDelivery").mockResolvedValue({ state: "reclaimed", reclaimable: false, onChainStatus: 4 });
    const res = await reclaimPATCH(new NextRequest("http://localhost/api/agenc/reclaim", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: w, taskPda: TASK_PDA }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { status: string } };
    expect(body.order.status).toBe("reclaimed");
  });
  it("PATCH REFUSES to mark reclaimed if the chain doesn't show it cancelled (griefing guard)", async () => {
    const w = "Cwc11111111111111111111111111111111111111111";
    recordOrder({ wallet: w, kind: "hire", itemPda: TASK_PDA2, name: "Agent", price: "0.01 SOL", txSig: sig() });
    // an attacker (or a premature call) — task is still awaiting, not cancelled
    vi.spyOn(reclaimLib, "getDelivery").mockResolvedValue({ state: "awaiting", reclaimable: true, onChainStatus: 0 });
    const res = await reclaimPATCH(new NextRequest("http://localhost/api/agenc/reclaim", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: w, taskPda: TASK_PDA2 }),
    }));
    expect(res.status).toBe(409); // never falsely marks another user's order reclaimed
    // and the order is untouched (still funded)
    const after = setOrderStatus(w, TASK_PDA2, "funded");
    expect(after?.status).toBe("funded");
  });
  it("PATCH with junk taskPda/wallet → 400 (before any chain read)", async () => {
    const res = await reclaimPATCH(new NextRequest("http://localhost/api/agenc/reclaim", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: "x", taskPda: "y" }),
    }));
    expect(res.status).toBe(400);
  });
});
