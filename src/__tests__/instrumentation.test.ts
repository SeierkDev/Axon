import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertReadyConfig } from "@/instrumentation";

// assertReadyConfig only validates in production. We temporarily override
// NODE_ENV and clear the required env vars to test the failure path.

const REQUIRED = [
  "NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS",
  "HELIUS_API_KEY",
  "SEED_SECRET",
  "DATABASE_PATH",
  "DATABASE_URL",
];

// mutableEnv.NODE_ENV is typed as read-only by some TS libs; bypass it.
const mutableEnv = process.env as Record<string, string | undefined>;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.NODE_ENV = mutableEnv.NODE_ENV;
  for (const key of REQUIRED) saved[key] = process.env[key];
});

afterEach(() => {
  mutableEnv.NODE_ENV = saved.NODE_ENV;
  for (const key of REQUIRED) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe("assertReadyConfig", () => {
  it("is a no-op outside production", () => {
    mutableEnv.NODE_ENV = "development";
    // Should not throw regardless of missing vars
    delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
    delete process.env.HELIUS_API_KEY;
    delete process.env.SEED_SECRET;
    delete process.env.DATABASE_PATH;
    delete process.env.DATABASE_URL;
    expect(() => assertReadyConfig()).not.toThrow();
  });

  it("throws with a checklist when required vars are missing in production", () => {
    mutableEnv.NODE_ENV = "production";
    delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
    delete process.env.HELIUS_API_KEY;
    delete process.env.SEED_SECRET;
    delete process.env.DATABASE_PATH;
    delete process.env.DATABASE_URL;

    expect(() => assertReadyConfig()).toThrow(/Axon startup failed/);
  });

  it("includes the names of all missing vars in the error message", () => {
    mutableEnv.NODE_ENV = "production";
    delete process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS;
    delete process.env.HELIUS_API_KEY;
    delete process.env.SEED_SECRET;
    delete process.env.DATABASE_PATH;
    delete process.env.DATABASE_URL;

    let message = "";
    try {
      assertReadyConfig();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS");
    expect(message).toContain("HELIUS_API_KEY");
    expect(message).toContain("SEED_SECRET");
    expect(message).toContain("DATABASE_PATH");
  });

  it("passes when all required vars are set", () => {
    mutableEnv.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = "11111111111111111111111111111111";
    process.env.HELIUS_API_KEY = "test-key";
    process.env.SEED_SECRET = "test-secret";
    process.env.DATABASE_PATH = "/data/axon.db";

    expect(() => assertReadyConfig()).not.toThrow();
  });

  it("skips HELIUS_API_KEY check when AXON_PAYMENT_VERIFIER=mock", () => {
    mutableEnv.NODE_ENV = "production";
    process.env.AXON_PAYMENT_VERIFIER = "mock";
    delete process.env.HELIUS_API_KEY;
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = "11111111111111111111111111111111";
    process.env.SEED_SECRET = "test-secret";
    process.env.DATABASE_PATH = "/data/axon.db";

    expect(() => assertReadyConfig()).not.toThrow();

    delete process.env.AXON_PAYMENT_VERIFIER;
  });
});
