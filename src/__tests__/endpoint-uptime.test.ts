import { describe, it, expect } from "vitest";
import {
  recordEndpointCheck,
  getEndpointUptime,
  getEndpointUptimeMap,
  pruneEndpointChecks,
} from "@/lib/endpointUptime";
import { getDb } from "@/lib/db";

let counter = 0;
function providerId(): string {
  counter++;
  return `prov-${counter}`;
}

describe("endpoint uptime", () => {
  it("returns empty for an endpoint with no checks", () => {
    expect(getEndpointUptime(providerId())).toEqual({
      checks: 0,
      up: 0,
      uptime: 0,
      lastCheckedAt: null,
      lastStatus: null,
    });
  });

  it("computes the uptime fraction from recorded checks", () => {
    const p = providerId();
    recordEndpointCheck(p, true);
    recordEndpointCheck(p, true);
    recordEndpointCheck(p, true);
    recordEndpointCheck(p, false);
    const u = getEndpointUptime(p);
    expect(u.checks).toBe(4);
    expect(u.up).toBe(3);
    expect(u.uptime).toBe(0.75);
  });

  it("reports the most recent status", () => {
    const p = providerId();
    recordEndpointCheck(p, true);
    recordEndpointCheck(p, false);
    expect(getEndpointUptime(p).lastStatus).toBe("down");
    recordEndpointCheck(p, true);
    expect(getEndpointUptime(p).lastStatus).toBe("up");
  });

  it("excludes observations older than the window", () => {
    const p = providerId();
    getDb()
      .prepare("INSERT INTO endpoint_checks (provider_id, ok, checked_at) VALUES (?, 1, ?)")
      .run(p, new Date(Date.now() - 30 * 86_400_000).toISOString()); // 30 days ago
    recordEndpointCheck(p, false); // recent
    const u = getEndpointUptime(p, 168); // 7-day window
    expect(u.checks).toBe(1);
    expect(u.up).toBe(0);
  });

  it("prunes observations older than the retention window", () => {
    const p = providerId();
    getDb()
      .prepare("INSERT INTO endpoint_checks (provider_id, ok, checked_at) VALUES (?, 1, ?)")
      .run(p, new Date(Date.now() - 40 * 86_400_000).toISOString()); // 40 days ago
    recordEndpointCheck(p, true); // recent
    expect(pruneEndpointChecks(30)).toBeGreaterThanOrEqual(1);
    expect(getEndpointUptime(p).checks).toBe(1); // the recent one survives
  });

  it("returns batched uptime for multiple endpoints in one call", () => {
    const a = providerId();
    const b = providerId();
    const empty = providerId(); // no observations
    recordEndpointCheck(a, true);
    recordEndpointCheck(a, false); // a: 1/2
    recordEndpointCheck(b, true);
    recordEndpointCheck(b, true); // b: 2/2
    const map = getEndpointUptimeMap([a, b, empty]);
    expect(map.get(a)?.uptime).toBe(0.5);
    expect(map.get(b)?.uptime).toBe(1);
    expect(map.has(empty)).toBe(false); // endpoints with no observations are absent
  });

  it("handles an empty id list", () => {
    expect(getEndpointUptimeMap([]).size).toBe(0);
  });
});
