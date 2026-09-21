import { describe, it, expect } from "vitest";
import { agentAvailability } from "@/lib/availability";

// "Available for hire now" used to be the fallback, reached by anything that was not currently
// working. Whether the agent still answered its endpoint was never part of the decision, so an
// agent whose endpoint had been refusing connections for weeks kept advertising itself.
const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR;

describe("what an agent is allowed to claim", () => {
  it("does not offer itself for hire when nobody can reach it", () => {
    const a = agentAvailability({
      running: 0, queued: 0, lastCompletedAt: null,
      verificationStatus: "unreachable", lastVerifiedAt: ago(9 * MIN), now: NOW,
    });
    expect(a.tone).toBe("down");
    expect(a.text).toBe("Not responding, last checked 9m ago");
  });

  it("says so even when it has nothing queued and nothing recent, the old fallback case", () => {
    const a = agentAvailability({
      running: 0, queued: 0, lastCompletedAt: ago(30 * DAY),
      verificationStatus: "unreachable", lastVerifiedAt: ago(2 * DAY), now: NOW,
    });
    expect(a.tone).toBe("down");
    expect(a.text).toContain("2d ago");
  });

  it("still reports work in flight, because a running task proves it is alive", () => {
    const a = agentAvailability({
      running: 2, queued: 3, lastCompletedAt: null,
      verificationStatus: "unreachable", lastVerifiedAt: ago(HOUR), now: NOW,
    });
    expect(a.tone).toBe("working");
    expect(a.text).toBe("Working on 2 tasks right now · 3 in queue");
  });

  it("falls back to a bare line when the endpoint has never been checked", () => {
    const a = agentAvailability({
      running: 0, queued: 0, lastCompletedAt: null,
      verificationStatus: "unreachable", lastVerifiedAt: null, now: NOW,
    });
    expect(a.text).toBe("Not responding");
  });

  it("leaves a reachable agent exactly as it was", () => {
    expect(agentAvailability({
      running: 0, queued: 0, lastCompletedAt: null,
      verificationStatus: "reachable", now: NOW,
    })).toEqual({ tone: "available", text: "Available for hire now" });

    expect(agentAvailability({
      running: 0, queued: 4, lastCompletedAt: null,
      verificationStatus: "reachable", now: NOW,
    }).text).toBe("4 tasks waiting in queue");

    expect(agentAvailability({
      running: 0, queued: 0, lastCompletedAt: ago(3 * HOUR),
      verificationStatus: "reachable", now: NOW,
    }).text).toBe("Idle, last job finished 3h ago");
  });

  it("treats an agent with no endpoint as before, since there is nothing to be unreachable", () => {
    for (const status of ["unverified", "platform", null, undefined]) {
      expect(agentAvailability({
        running: 0, queued: 0, lastCompletedAt: null,
        verificationStatus: status, now: NOW,
      }).tone).toBe("available");
    }
  });

  it("does not call a long-idle agent idle, which would read as a dead network", () => {
    expect(agentAvailability({
      running: 0, queued: 0, lastCompletedAt: ago(17 * DAY),
      verificationStatus: "reachable", now: NOW,
    }).tone).toBe("available");
  });
});
