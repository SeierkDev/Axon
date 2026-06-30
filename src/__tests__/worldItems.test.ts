// Tests for Axon World's item/loot tables — fishing catches and the daily
// house gift chests.

import { describe, it, expect } from "vitest";
import { ITEMS, rollCatch, rollGift, RARITY_COLOR, RARITY_ORDER } from "@/app/world/items";

describe("world items", () => {
  it("every item has a rarity with a colour and sort position", () => {
    for (const def of Object.values(ITEMS)) {
      expect(RARITY_COLOR[def.rarity]).toBeTruthy();
      expect(RARITY_ORDER).toContain(def.rarity);
    }
  });

  it("rollCatch always returns a defined item across the whole roll range", () => {
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
      const item = rollCatch(() => r);
      expect(item).toBeDefined();
      expect(ITEMS[item.id]).toBe(item);
    }
  });

  it("rollGift always returns a defined item and never a legendary", () => {
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
      const item = rollGift(() => r);
      expect(item).toBeDefined();
      expect(ITEMS[item.id]).toBe(item);
      expect(item.rarity).not.toBe("legendary");
    }
  });

  it("gift odds favour common items", () => {
    // Deterministic sweep across the whole distribution.
    let common = 0;
    let total = 0;
    for (let i = 0; i < 1000; i++) {
      const item = rollGift(() => i / 1000);
      total++;
      if (item.rarity === "common") common++;
    }
    expect(common / total).toBeGreaterThan(0.5);
  });
});
