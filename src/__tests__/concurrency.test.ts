// Tests that the MPP channel debit is race-condition-safe.
// better-sqlite3 is synchronous, so these run sequentially in JS — the
// real protection is the SQLite atomic read-then-update-only-if-sufficient-balance.
// The test proves the check correctly enforces the limit under rapid sequential fire.

import { describe, it, expect } from "vitest";
import { createChannel, debitChannel, recordDeposit, type MppUsdcAmount } from "@/lib/mpp";

const ONE_USDC: MppUsdcAmount = { amountUsdc: 1.0, microUsdc: 1_000_000 };
const TWENTY_CENTS: MppUsdcAmount = { amountUsdc: 0.2, microUsdc: 200_000 };

describe("MPP debit: race condition protection", () => {
  it("allows exactly N debits before exhausting balance", () => {
    const { channel } = createChannel("wallet_concurrent_test_1");

    // Fund with exactly 1.00 USDC (5 × 0.20)
    recordDeposit(channel.channelId, ONE_USDC, `sig-concurrent-${Date.now()}`);

    // Simulate 10 rapid debits — only the first 5 should succeed
    const results = Array.from({ length: 10 }, (_, i) =>
      debitChannel(channel.channelId, "test-agent", TWENTY_CENTS, `task-concurrent-${i}`)
    );

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    expect(successes).toHaveLength(5);
    expect(failures).toHaveLength(5);

    // Verify final balance is exactly 0
    const lastSuccess = successes[successes.length - 1];
    expect(lastSuccess.remainingBalance).toBe(0);
  });

  it("never goes negative even under burst fire", () => {
    const { channel } = createChannel("wallet_concurrent_test_2");
    recordDeposit(channel.channelId, { amountUsdc: 0.5, microUsdc: 500_000 }, `sig-burst-${Date.now()}`);

    // Fire 20 debits of 0.10 USDC — only 5 should succeed ($0.50 / $0.10)
    const TEN_CENTS: MppUsdcAmount = { amountUsdc: 0.1, microUsdc: 100_000 };
    const results = Array.from({ length: 20 }, (_, i) =>
      debitChannel(channel.channelId, "test-agent", TEN_CENTS, `task-burst-${i}`)
    );

    const successBalances = results
      .filter((r) => r.success && r.remainingBalance !== undefined)
      .map((r) => r.remainingBalance!);

    // All successful debits must report non-negative remaining balance
    expect(successBalances.every((b) => b >= 0)).toBe(true);

    // Exactly 5 should succeed
    expect(results.filter((r) => r.success)).toHaveLength(5);
  });

  it("a single large debit that exceeds balance fails cleanly", () => {
    const { channel } = createChannel("wallet_concurrent_test_3");
    recordDeposit(channel.channelId, TWENTY_CENTS, `sig-small-${Date.now()}`);

    const result = debitChannel(channel.channelId, "test-agent", ONE_USDC, "task-over");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/[Ii]nsufficient/);
  });
});
