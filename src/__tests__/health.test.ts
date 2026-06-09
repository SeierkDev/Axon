// Tests for src/lib/health.ts
// Verifies report structure, check presence, and state reflection

import { vi, describe, it, expect, afterEach } from "vitest";
import { getHealthReport, getReadinessReport } from "@/lib/health";
import { getDb } from "@/lib/db";
import * as solanaModule from "@/lib/solana";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ── getHealthReport ───────────────────────────────────────────────────────────

describe("getHealthReport: structure", () => {
  it("returns a report with required top-level fields", () => {
    const report = getHealthReport();
    expect(report.service).toBe("axon");
    expect(report.status).toBe("live");
    expect(typeof report.ok).toBe("boolean");
    expect(typeof report.timestamp).toBe("string");
    expect(typeof report.uptimeSeconds).toBe("number");
    expect(Array.isArray(report.checks)).toBe(true);
  });

  it("includes all expected check names", () => {
    const report = getHealthReport();
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("runtime");
    expect(names).toContain("database");
    expect(names).toContain("memory");
    expect(names).toContain("tasks");
    expect(names).toContain("agents");
    expect(names).toContain("helius_circuit");
  });

  it("reports database as ok in the test environment", () => {
    const report = getHealthReport();
    const db = report.checks.find((c) => c.name === "database")!;
    expect(db.status).toBe("ok");
  });

  it("reports helius_circuit state as closed (no failures in test environment)", () => {
    const report = getHealthReport();
    const circuit = report.checks.find((c) => c.name === "helius_circuit")!;
    expect(circuit.status).toBe("ok");
    expect(circuit.details?.state).toBe("closed");
    expect(circuit.details?.consecutiveFailures).toBe(0);
  });

  it("sets ok:true when no checks are in error state", () => {
    const report = getHealthReport();
    const hasError = report.checks.some((c) => c.status === "error");
    if (!hasError) {
      expect(report.ok).toBe(true);
    }
  });
});

// ── getReadinessReport ────────────────────────────────────────────────────────

describe("getReadinessReport: structure", () => {
  it("returns a report with required top-level fields", () => {
    const report = getReadinessReport();
    expect(report.service).toBe("axon");
    expect(typeof report.ok).toBe("boolean");
    expect(typeof report.timestamp).toBe("string");
    expect(Array.isArray(report.checks)).toBe(true);
  });

  it("includes all expected check names", () => {
    const report = getReadinessReport();
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("runtime");
    expect(names).toContain("database");
    expect(names).toContain("migrations");
    expect(names).toContain("production_config");
  });

  it("reports database as ok in the test environment", () => {
    const report = getReadinessReport();
    const db = report.checks.find((c) => c.name === "database")!;
    expect(db.status).toBe("ok");
  });

  it("reports migrations as ok with applied count", () => {
    const report = getReadinessReport();
    const mig = report.checks.find((c) => c.name === "migrations")!;
    expect(mig.status).toBe("ok");
    expect(typeof mig.details?.applied).toBe("number");
    expect(Array.isArray(mig.details?.versions)).toBe(true);
  });

  it("skips production-only config checks outside of production", () => {
    const report = getReadinessReport();
    const prodConfig = report.checks.find((c) => c.name === "production_config")!;
    // In test env (NODE_ENV=test), the check skips with an ok status
    expect(prodConfig.status).toBe("ok");
    expect(prodConfig.message).toMatch(/skip/i);
  });

  it("report is ok when all checks pass", () => {
    const report = getReadinessReport();
    const allChecksPassed = report.checks.every((c) => c.status !== "error");
    expect(report.ok).toBe(allChecksPassed);
  });
});

// ── production_config branches (only reachable when NODE_ENV === "production") ─

describe("getReadinessReport: production_config error path", () => {
  it("returns error when required env vars are missing in production", () => {
    const origWallet = process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
    const origVerifier = process.env.AXON_PAYMENT_VERIFIER;
    try {
      vi.stubEnv("NODE_ENV", "production");
      delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
      delete process.env.AXON_PAYMENT_VERIFIER;

      const report = getReadinessReport();
      const check = report.checks.find((c) => c.name === "production_config")!;
      expect(check.status).toBe("error");
      expect(check.details?.missingRequired).toContain("NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS");
      expect(report.ok).toBe(false);
    } finally {
      if (origWallet !== undefined) process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = origWallet;
      if (origVerifier !== undefined) process.env.AXON_PAYMENT_VERIFIER = origVerifier;
    }
  });
});

describe("getReadinessReport: production_config warn path", () => {
  it("returns warn when recommended env vars are missing in production", () => {
    const origAnthropic = process.env.ANTHROPIC_API_KEY;
    const origSeed = process.env.SEED_SECRET;
    const origVerifier = process.env.AXON_PAYMENT_VERIFIER;
    try {
      vi.stubEnv("NODE_ENV", "production");
      // AXON_PAYMENT_VERIFIER=mock skips the HELIUS_API_KEY requirement
      process.env.AXON_PAYMENT_VERIFIER = "mock";
      // Required vars are present; remove recommended vars
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.SEED_SECRET;

      const report = getReadinessReport();
      const check = report.checks.find((c) => c.name === "production_config")!;
      expect(check.status).toBe("warn");
      expect(Array.isArray(check.details?.missingRecommended)).toBe(true);
    } finally {
      if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic;
      else delete process.env.ANTHROPIC_API_KEY;
      if (origSeed !== undefined) process.env.SEED_SECRET = origSeed;
      else delete process.env.SEED_SECRET;
      if (origVerifier !== undefined) process.env.AXON_PAYMENT_VERIFIER = origVerifier;
      else delete process.env.AXON_PAYMENT_VERIFIER;
    }
  });
});

describe("getReadinessReport: production_config ok path", () => {
  it("returns ok when all required and recommended env vars are present in production", () => {
    const origAnthropic = process.env.ANTHROPIC_API_KEY;
    const origSeed = process.env.SEED_SECRET;
    const origVerifier = process.env.AXON_PAYMENT_VERIFIER;
    try {
      vi.stubEnv("NODE_ENV", "production");
      process.env.AXON_PAYMENT_VERIFIER = "mock";
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.SEED_SECRET = "test-secret";

      const report = getReadinessReport();
      const check = report.checks.find((c) => c.name === "production_config")!;
      expect(check.status).toBe("ok");
      expect(check.message).toBeUndefined();
    } finally {
      if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic;
      else delete process.env.ANTHROPIC_API_KEY;
      if (origSeed !== undefined) process.env.SEED_SECRET = origSeed;
      else delete process.env.SEED_SECRET;
      if (origVerifier !== undefined) process.env.AXON_PAYMENT_VERIFIER = origVerifier;
      else delete process.env.AXON_PAYMENT_VERIFIER;
    }
  });
});

// ── checkHeliusCircuit branches ───────────────────────────────────────────────

describe("getHealthReport: helius_circuit open → error status", () => {
  it("reports error status when the helius circuit is open", () => {
    vi.spyOn(solanaModule, "getHeliusCircuitState").mockReturnValueOnce({
      state: "open",
      consecutiveFailures: 4,
    });

    const report = getHealthReport();
    const check = report.checks.find((c) => c.name === "helius_circuit")!;
    expect(check.status).toBe("error");
    expect(check.details?.state).toBe("open");
    expect(check.details?.consecutiveFailures).toBe(4);
    expect(report.ok).toBe(false);
  });
});

describe("getHealthReport: helius_circuit half-open → warn status", () => {
  it("reports warn status when the helius circuit is half-open", () => {
    vi.spyOn(solanaModule, "getHeliusCircuitState").mockReturnValueOnce({
      state: "half-open",
      consecutiveFailures: 1,
    });

    const report = getHealthReport();
    const check = report.checks.find((c) => c.name === "helius_circuit")!;
    expect(check.status).toBe("warn");
    expect(check.details?.state).toBe("half-open");
  });
});

// ── checkTaskStats and checkAgentStats error paths ────────────────────────────

describe("getHealthReport: tasks check warn when DB query throws", () => {
  it("returns warn status for the tasks check when the DB query throws", () => {
    const db = getDb();
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("tasks GROUP BY status")) throw new Error("no such table: tasks");
      return origPrepare(sql);
    });

    const report = getHealthReport();
    const check = report.checks.find((c) => c.name === "tasks")!;
    expect(check.status).toBe("warn");
    expect(check.message).toMatch(/tasks/i);
  });
});

describe("getHealthReport: agents check warn when DB query throws", () => {
  it("returns warn status for the agents check when the DB query throws", () => {
    const db = getDb();
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("COUNT(*) AS total FROM agents")) throw new Error("no such table: agents");
      return origPrepare(sql);
    });

    const report = getHealthReport();
    const check = report.checks.find((c) => c.name === "agents")!;
    expect(check.status).toBe("warn");
    expect(check.message).toMatch(/agents/i);
  });
});
