import { describe, it, expect } from "vitest";
import { getSystemStatus } from "@/lib/status";
import { getSyncHealth } from "@/lib/db-turso";
import { getDb } from "@/lib/db";

function setWorkerHeartbeat(agoMs: number) {
  const ts = new Date(Date.now() - agoMs).toISOString();
  getDb()
    .prepare("INSERT OR REPLACE INTO worker_state (key, value, updated_at) VALUES ('last_seen', 'ok', ?)")
    .run(ts);
}

describe("system status", () => {
  it("reports components, overall status, and live metrics", () => {
    setWorkerHeartbeat(5_000); // fresh
    const s = getSystemStatus();
    expect(s.components.map((c) => c.name)).toEqual(["API", "Database", "Background worker"]);
    expect(s.components.find((c) => c.name === "Database")?.status).toBe("operational");
    expect(s.metrics).toHaveProperty("queueDepth");
    expect(s.metrics).toHaveProperty("successRate");
    expect(typeof s.updatedAt).toBe("string");
  });

  it("reports the database operational when Turso sync is not configured", () => {
    // No DATABASE_URL in tests → sync not configured → database reads operational.
    expect(getSyncHealth().configured).toBe(false);
    setWorkerHeartbeat(5_000);
    expect(getSystemStatus().components.find((c) => c.name === "Database")?.status).toBe("operational");
  });

  it("stays operational through Turso replica sync lag (up to ~2 min)", () => {
    setWorkerHeartbeat(5_000);
    expect(getSystemStatus().components.find((c) => c.name === "Background worker")?.status).toBe("operational");
    // A heartbeat lagged ~2 min by cross-process replica sync must NOT read degraded.
    setWorkerHeartbeat(2 * 60_000);
    expect(getSystemStatus().components.find((c) => c.name === "Background worker")?.status).toBe("operational");
    expect(getSystemStatus().status).toBe("operational");
  });

  it("degrades when the worker is silent for >5 min and goes down >15 min", () => {
    setWorkerHeartbeat(6 * 60_000); // 6 min
    expect(getSystemStatus().components.find((c) => c.name === "Background worker")?.status).toBe("degraded");
    expect(getSystemStatus().status).toBe("degraded"); // overall = worst

    setWorkerHeartbeat(16 * 60_000); // 16 min
    expect(getSystemStatus().components.find((c) => c.name === "Background worker")?.status).toBe("down");
    expect(getSystemStatus().status).toBe("down");
  });
});
