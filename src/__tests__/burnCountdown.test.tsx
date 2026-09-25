// The burn page in the state nobody can see until the token launches.
//
// Before launch the page only ever renders the "not live yet" branch, so the countdown, the ring
// and the totals would ship unexercised and first run in front of people on launch day. Rendering
// the component against a pot that looks live covers the half that matters.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BurnClient, { secondsUntilFees, type BurnPayload } from "@/app/burn/BurnClient";
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
    // No pot address is the genuine pre-launch state: there is nothing deployed to read.
    const html = render(pot({ live: false, launched: false, nextBurnAt: 0, potAddress: null }));
    expect(html).toContain("not live yet");
  });

  it("says the chain is unreachable when a pot exists but could not be read", () => {
    // A different thing entirely, and it used to render as the one above. A failed read is a fact
    // about the connection, and the page must not turn it into "the burn has not started" on the
    // page that every burn post links to.
    const html = render(pot({ live: false, launched: false, nextBurnAt: 0, burnCount: 0 }));

    expect(html).toContain("Cannot reach the chain");
    expect(html).not.toContain("not live yet");
  });
});

// ── waiting on fees rather than on the clock ─────────────────────────────────
//
// After the token graduated, trading fees are released to the pot on someone else's schedule. When
// that is slower than the cooldown, the pot is funded and burned within seconds and its balance
// reads zero at every other moment. The page has to say where the burn actually is, or a perfectly
// healthy burn reads as a stopped one.

const waitingOnFees = (over: Partial<BurnPayload> = {}) =>
  pot({
    // Nothing in the pot and nothing scheduled: the ordinary state between releases.
    potBalanceEth: 0,
    nextBurnEth: 0,
    nextBurnAt: 0,
    pendingEth: 0,
    cadence: { medianGapSeconds: 69 * 60, sample: 8, boundBy: "delivery", nextDeliveryEstimate: now + 12 * 60 },
    ...over,
  });

describe("when fees, not the cooldown, are the wait", () => {
  it("counts down to when fees are expected instead of showing an empty pot", () => {
    const html = render(waitingOnFees());

    expect(html).toContain("until fees expected");
    expect(html).toContain("12:00");
  });

  it("drives that clock off the ticking time, not the server read", () => {
    // The bug this exists to stop: computing the countdown from `readAt`, which is fixed at the
    // moment the server read the chain, so the clock renders once and then sits frozen until a
    // reload. Tested on the calculation directly, because a static render cannot advance a timer.
    const due = now + 12 * 60;

    expect(secondsUntilFees(due, now)).toBe(12 * 60);
    expect(secondsUntilFees(due, now + 60)).toBe(11 * 60);
    expect(secondsUntilFees(due, now + 11 * 60 + 59)).toBe(1);
  });

  it("never counts past zero into a negative clock", () => {
    expect(secondsUntilFees(now - 500, now)).toBe(0);
  });

  it("has nothing to count when there is no estimate", () => {
    expect(secondsUntilFees(null, now)).toBeNull();
  });

  it("says fees are due rather than freezing at zero when the estimate runs out", () => {
    // The estimate is a median, so fees arrive either side of it. A clock stuck on 00:00 is exactly
    // the stopped-looking thing this replaced.
    const html = render(waitingOnFees({ cadence: { medianGapSeconds: 69 * 60, sample: 8, boundBy: "delivery", nextDeliveryEstimate: now - 60 } }));

    expect(html).toContain("Any moment");
    expect(html).not.toContain("00:00");
  });

  it("shows fees already released and on their way in", () => {
    const html = render(waitingOnFees({ pendingEth: 0.0548 }));

    // The state that made this look broken: money exists, the pot is still zero.
    expect(html).toContain("0.0548");
    expect(html).toContain("ETH inbound");
  });

  it("states the measured cadence rather than a fixed schedule", () => {
    const html = render(waitingOnFees());
    expect(html).toContain("about 69 minutes apart");
  });

  it("goes back to the normal countdown when fees arrive faster than the cooldown", () => {
    // No edit and no deploy: the same code reads a faster cadence and the page returns to counting
    // down the contract's own interval.
    const html = render(
      pot({ cadence: { medianGapSeconds: 29 * 60, sample: 8, boundBy: "cooldown", nextDeliveryEstimate: null } }),
    );

    expect(html).toContain("until next burn");
    expect(html).toContain("at the 30 minute minimum");
  });

  it("renders when a cached response predates these fields", () => {
    // A browser holding JSON from before this shipped must not take the page down.
    const legacy = pot();
    delete (legacy as Partial<BurnPayload>).cadence;
    delete (legacy as Partial<BurnPayload>).pendingEth;

    expect(() => render(legacy)).not.toThrow();
  });
});
