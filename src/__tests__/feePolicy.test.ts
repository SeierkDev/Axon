import { describe, it, expect } from "vitest";
import { getFeePolicy } from "@/lib/feePolicy";

describe("fee policy", () => {
  it("publishes a versioned, zero-platform-fee policy", () => {
    const p = getFeePolicy();
    expect(p.version).toBeTruthy();
    expect(p.effectiveDate).toBeTruthy();
    expect(p.currency).toBe("USDC");
    // The published policy charges payers no platform fee on top of the agent price.
    expect(p.peerToPeer.platformFeeBps).toBe(0);
    expect(p.hostedAgents.platformFeeBps).toBe(0);
    expect(p.rails.length).toBeGreaterThan(0);
    expect(p.notes.length).toBeGreaterThan(0);
  });
});
