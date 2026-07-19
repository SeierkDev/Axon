// verifyReceipt runs entirely against a real production trace captured as a
// fixture — no network. The valid chain must verify; every class of tamper
// (edited field, reordered events, dropped event) must be caught.

import { describe, it, expect } from "vitest";
import { verifyReceipt } from "../src/verify";
import validTrace from "./fixtures/trace-valid.json";

const TASK_ID = validTrace.taskId as string;

// A fetch stub that always returns the given trace object.
function serve(trace: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => trace })) as unknown as typeof fetch;
}

// Deep clone so each test mutates its own copy.
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("verifyReceipt", () => {
  it("verifies an untampered production trace by recomputing every hash", async () => {
    const r = await verifyReceipt(TASK_ID, { fetch: serve(validTrace) });
    expect(r.chainValid).toBe(true);
    expect(r.brokenAt).toBeNull();
    expect(r.eventCount).toBe(validTrace.events.length);
    expect(r.verified).toBe(true);
    // The SDK's independent verdict agrees with the platform's own claim…
    expect(r.chainValid).toBe(r.platformClaim);
    // …but the verdict is the recomputation, not the platform flag.
  });

  it("catches a silently edited hashed field", async () => {
    const t = clone(validTrace);
    const ev = t.events.find((e: { seq: number }) => e.seq === 2) ?? t.events[1];
    ev.outputTokens = (ev.outputTokens ?? 0) + 1;
    const r = await verifyReceipt(TASK_ID, { fetch: serve(t) });
    expect(r.chainValid).toBe(false);
    expect(r.brokenAt).toBe(2);
  });

  it("catches reordered events (broken prevHash linkage)", async () => {
    const t = clone(validTrace);
    if (t.events.length >= 3) {
      const tmp = t.events[1];
      t.events[1] = t.events[2];
      t.events[2] = tmp;
    }
    const r = await verifyReceipt(TASK_ID, { fetch: serve(t) });
    expect(r.chainValid).toBe(false);
    expect(r.brokenAt).not.toBeNull();
  });

  it("catches a dropped event (broken seq contiguity)", async () => {
    const t = clone(validTrace);
    t.events = t.events.filter((e: { seq: number }) => e.seq !== 2);
    const r = await verifyReceipt(TASK_ID, { fetch: serve(t) });
    expect(r.chainValid).toBe(false);
    expect(r.brokenAt).not.toBeNull();
  });

  it("reports an empty trace as unverifiable, not valid", async () => {
    const t = clone(validTrace);
    t.events = [];
    const r = await verifyReceipt(TASK_ID, { fetch: serve(t) });
    expect(r.chainValid).toBe(false);
    expect(r.eventCount).toBe(0);
  });
});
