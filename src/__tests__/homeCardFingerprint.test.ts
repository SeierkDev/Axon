import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * The card was live and nobody ever saw it change.
 *
 * Next.js names the image with a hash of its own source file, so the URL only moved when that file
 * was edited. Telegram and X cache a preview against the URL they were handed, which froze the
 * figures while the route underneath went on serving fresh numbers nothing ever asked for. The
 * fingerprint exists to put the figures in the URL, so these tests are about one property: it must
 * move when the card would look different, and hold still when it would not.
 */

const withStats = async (stats: { agents: number; completed: number; rate: number; caps: number }) => {
  vi.resetModules();
  vi.doMock("@/lib/analytics", () => ({
    getNetworkStats: () => ({
      agents: { total: stats.agents },
      tasks: { completed: stats.completed, successRate: stats.rate },
      capabilities: stats.caps,
    }),
  }));
  const { homeCardFingerprint } = await import("@/app/homeCard");
  return homeCardFingerprint();
};

const BASE = { agents: 79, completed: 20_010, rate: 0.98, caps: 42 };

describe("the card's fingerprint", () => {
  afterEach(() => vi.restoreAllMocks());

  it("holds still when nothing on the card changed", async () => {
    expect(await withStats(BASE)).toBe(await withStats(BASE));
  });

  it("moves when a task completes", async () => {
    // This is the case that was broken in the screenshot: the message said 20,010 tasks and the
    // card beside it still said 19,439.
    expect(await withStats({ ...BASE, completed: 20_011 })).not.toBe(await withStats(BASE));
  });

  it("moves when an agent registers", async () => {
    expect(await withStats({ ...BASE, agents: 80 })).not.toBe(await withStats(BASE));
  });

  it("moves when the success rate rounds differently", async () => {
    // 96% and 98% are different cards. A rate that moves without changing the rounded figure is not.
    expect(await withStats({ ...BASE, rate: 0.96 })).not.toBe(await withStats(BASE));
    expect(await withStats({ ...BASE, rate: 0.9801 })).toBe(await withStats(BASE));
  });

  it("is short enough to sit in a URL", async () => {
    const fp = await withStats(BASE);
    expect(fp).toMatch(/^[a-z0-9]{1,8}$/);
  });

  it("still returns something when the figures cannot be read", async () => {
    vi.resetModules();
    vi.doMock("@/lib/analytics", () => ({
      getNetworkStats: () => { throw new Error("database down"); },
    }));
    const { homeCardFingerprint } = await import("@/app/homeCard");
    // A card with no figures still unfurls, so its URL still has to resolve.
    expect(homeCardFingerprint()).toBeTruthy();
  });
});
