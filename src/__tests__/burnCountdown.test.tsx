// The burn page in the state nobody can see until the token launches.
//
// Before launch the page only ever renders the "not live yet" branch, so the countdown, the ring
// and the totals would ship unexercised and first run in front of people on launch day. Rendering
// the component against a pot that looks live covers the half that matters.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BurnClient, { type BurnPayload } from "@/app/burn/BurnClient";
import { BURN_RULES } from "@/lib/burnLive";

const now = Math.floor(Date.now() / 1000);

function pot(over: Partial<BurnPayload> = {}): BurnPayload {
  return {
    live: true,
    launched: true,
    potAddress: "0x1111111111111111111111111111111111111111",
    tokenAddress: "0x2222222222222222222222222222222222222222",
    potBalanceEth: 1.25,
    nextBurnEth: 0.0125,
    nextBurnAt: now + 9 * 60 + 5, // 9:05 out
    lastBurnAt: now - 20 * 60,
    ready: false,
    burnCount: 17,
    totalEthBurned: 0.4213,
    totalTokensBurned: 12_500_000,
    explorer: { pot: "https://e/pot", token: "https://e/token", dead: "https://e/dead" },
    rules: BURN_RULES,
    readAt: now,
    forwarded: { totalEth: 0.5, pendingEth: 0.02 },
    ...over,
  };
}

const render = (p: BurnPayload) => renderToStaticMarkup(<BurnClient initial={p} />);

describe("the burn countdown", () => {
  it("counts down in minutes and seconds toward the next burn", () => {
    const html = render(pot());
    expect(html).toContain("09:05");
    expect(html).toContain("until next burn");
  });

  it("pads both halves so the clock does not jump width", () => {
    expect(render(pot({ nextBurnAt: now + 61 }))).toContain("01:01");
    expect(render(pot({ nextBurnAt: now + 5 }))).toContain("00:05");
  });

  it("says a burn is due rather than showing a negative clock", () => {
    const html = render(pot({ nextBurnAt: now - 120, ready: true }));
    expect(html).toContain("Due");
    // and specifically not a clock that has run past zero into negatives
    expect(html).not.toMatch(/-\d+:\d\d/);
    expect(html).toContain("Anyone can fire it");
  });

  it("shows what the next burn would spend, and the totals so far", () => {
    const html = render(pot());
    expect(html).toContain("0.0125"); // next burn amount
    expect(html).toContain("0.4213"); // total ETH burned
    expect(html).toContain("17"); // burn count
    expect(html).toContain("12.50M"); // tokens burned, compacted
  });

  it("reports how long ago the last burn was", () => {
    expect(render(pot({ lastBurnAt: now - 20 * 60 }))).toContain("20m ago");
    expect(render(pot({ lastBurnAt: 0 }))).toContain("never");
  });

  it("falls back to idle when the pot is deployed but the token has not launched", () => {
    const html = render(pot({ launched: false, nextBurnAt: 0 }));
    expect(html).toContain("Idle");
    expect(html).toContain("waiting on the token");
  });

  it("says so plainly when there is no pot at all", () => {
    const html = render(pot({ live: false, launched: false, nextBurnAt: 0 }));
    expect(html).toContain("not live yet");
  });
});
