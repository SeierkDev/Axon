// The burn loop must run once per process however many copies of its module the server loads.
//
// Production loaded two (instrumentation and the request-serving code) and logged burn.loop_started
// twice per boot: two loops sweeping and racing each other to burn. These tests load the module twice
// the same way and check there is one loop and one shared state.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const env = { ...process.env };

beforeEach(() => {
  vi.useFakeTimers(); // the first tick is scheduled but never fired, so nothing reaches a node
  vi.resetModules();
  delete (globalThis as { __axonBurnLoop?: unknown }).__axonBurnLoop;
  process.env.AXON_BURN_POT_ADDRESS = "0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9";
  process.env.BOT_PRIVATE_KEY = "0x" + "11".repeat(32);
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...env };
  delete (globalThis as { __axonBurnLoop?: unknown }).__axonBurnLoop;
});

async function freshCopy() {
  vi.resetModules();
  return import("@/lib/burnLoop");
}

describe("burn loop: one per process", () => {
  it("a second copy of the module does not start a second loop", async () => {
    const a = await freshCopy();
    const b = await freshCopy();
    a.startBurnLoop();
    b.startBurnLoop();
    // Each running loop keeps exactly one tick scheduled.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("the copy that did not start the loop still sees it running", async () => {
    const a = await freshCopy();
    const b = await freshCopy();
    expect(b.burnLoopState().started).toBe(false);
    a.startBurnLoop();
    // What /api/burn/health reads, from the copy serving requests.
    expect(b.burnLoopState().started).toBe(true);
  });

  it("does not start without a pot and a key", async () => {
    delete process.env.BOT_PRIVATE_KEY;
    const a = await freshCopy();
    a.startBurnLoop();
    expect(a.burnLoopState().started).toBe(false);
  });
});
