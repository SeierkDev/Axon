// Must be set before any module import so the mock verifier is active at load time
process.env.AXON_PAYMENT_VERIFIER = "mock";

import { describe, it, expect } from "vitest";
import { createPayment } from "@/lib/payments";
import { createTask, getTaskByIdempotency } from "@/lib/tasks";
import { createAgent } from "@/lib/agents";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashIdempotencyPayload } from "@/lib/idempotency";
import type { Agent } from "@/sdk/types";

const TEST_WALLET = "11111111111111111111111111111111";
let counter = 0;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `rc-${counter}`,
    name: `Race Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pk${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockSig(nonce: string | number, units = 1_000_000, currency = "USDC"): string {
  return `mockpay:${currency}:${units}:${TEST_WALLET}:${TEST_WALLET}:${nonce}`;
}

// ── Double-spend: concurrent createPayment with the same signature ─────────────

describe("double-spend protection", () => {
  it("exactly one of two concurrent createPayment calls succeeds", async () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);

    const sig = mockSig(`ds-${counter++}`);

    // Fire both calls simultaneously. verifyIncomingPayment is async (even for
    // the mock), so both pass the fast pre-check before either commits. The
    // SQLite transaction then serialises them: the second sees the first's
    // committed signature and throws "Payment signature already used".
    const [r1, r2] = await Promise.allSettled([
      createPayment({
        fromAgent: sender.agentId,
        toAgent: receiver.agentId,
        amountSol: 1,
        paymentSignature: sig,
        priceString: "1 USDC",
      }),
      createPayment({
        fromAgent: sender.agentId,
        toAgent: receiver.agentId,
        amountSol: 1,
        paymentSignature: sig,
        priceString: "1 USDC",
      }),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already used/);
  });

  it("replaying a committed signature is rejected", async () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);

    const sig = mockSig(`ds-seq-${counter++}`);
    await createPayment({
      fromAgent: sender.agentId,
      toAgent: receiver.agentId,
      amountSol: 1,
      paymentSignature: sig,
      priceString: "1 USDC",
    });

    await expect(
      createPayment({
        fromAgent: sender.agentId,
        toAgent: receiver.agentId,
        amountSol: 1,
        paymentSignature: sig,
        priceString: "1 USDC",
      })
    ).rejects.toThrow(/already used/);
  });

  it("distinct signatures for the same sender/receiver pair both succeed", async () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);

    const [r1, r2] = await Promise.allSettled([
      createPayment({
        fromAgent: sender.agentId,
        toAgent: receiver.agentId,
        amountSol: 1,
        paymentSignature: mockSig(`ds-ok-a-${counter++}`),
        priceString: "1 USDC",
      }),
      createPayment({
        fromAgent: sender.agentId,
        toAgent: receiver.agentId,
        amountSol: 1,
        paymentSignature: mockSig(`ds-ok-b-${counter++}`),
        priceString: "1 USDC",
      }),
    ]);

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
  });
});

// ── Idempotency race: concurrent createTask with the same scope + key ─────────

describe("idempotency race", () => {
  it("exactly one of two concurrent createTask calls with the same key succeeds", async () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);

    const scope = `tasks:${sender.agentId}`;
    const key = `idem-race-${counter++}`;
    const hash = hashIdempotencyPayload({ task: "work" });

    // createTask is synchronous; wrapping in Promise.resolve().then() schedules
    // both as microtasks so they run back-to-back. The UNIQUE index on
    // (idempotency_scope, idempotency_key) ensures the second throws.
    const [r1, r2] = await Promise.allSettled([
      Promise.resolve().then(() =>
        createTask({
          fromAgent: sender.agentId,
          toAgent: receiver.agentId,
          task: "work",
          idempotencyScope: scope,
          idempotencyKey: key,
          idempotencyHash: hash,
        })
      ),
      Promise.resolve().then(() =>
        createTask({
          fromAgent: sender.agentId,
          toAgent: receiver.agentId,
          task: "work",
          idempotencyScope: scope,
          idempotencyKey: key,
          idempotencyHash: hash,
        })
      ),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("getTaskByIdempotency returns the sole created task for the key", () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);

    const scope = `tasks:${sender.agentId}`;
    const key = `idem-lookup-${counter++}`;
    const hash = hashIdempotencyPayload({ task: "lookup-work" });

    const task = createTask({
      fromAgent: sender.agentId,
      toAgent: receiver.agentId,
      task: "lookup-work",
      idempotencyScope: scope,
      idempotencyKey: key,
      idempotencyHash: hash,
    });

    const found = getTaskByIdempotency(scope, key);
    expect(found).not.toBeNull();
    expect(found!.task.taskId).toBe(task.taskId);
    expect(found!.hash).toBe(hash);
  });

  it("different keys within the same scope create independent tasks", () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);

    const scope = `tasks:${sender.agentId}`;
    const key1 = `idem-multi-a-${counter++}`;
    const key2 = `idem-multi-b-${counter++}`;
    const hash = hashIdempotencyPayload({ task: "work" });

    const t1 = createTask({
      fromAgent: sender.agentId,
      toAgent: receiver.agentId,
      task: "work",
      idempotencyScope: scope,
      idempotencyKey: key1,
      idempotencyHash: hash,
    });
    const t2 = createTask({
      fromAgent: sender.agentId,
      toAgent: receiver.agentId,
      task: "work",
      idempotencyScope: scope,
      idempotencyKey: key2,
      idempotencyHash: hash,
    });

    expect(t1.taskId).not.toBe(t2.taskId);
    expect(getTaskByIdempotency(scope, key1)!.task.taskId).toBe(t1.taskId);
    expect(getTaskByIdempotency(scope, key2)!.task.taskId).toBe(t2.taskId);
  });

  it("null scope/key allows duplicate task bodies without conflict", () => {
    const sender = makeAgent();
    const receiver = makeAgent();
    createAgent(sender);
    createAgent(receiver);

    const t1 = createTask({ fromAgent: sender.agentId, toAgent: receiver.agentId, task: "open" });
    const t2 = createTask({ fromAgent: sender.agentId, toAgent: receiver.agentId, task: "open" });

    expect(t1.taskId).not.toBe(t2.taskId);
  });
});

// ── Rate-limit: concurrent burst stays within allowed count ───────────────────

describe("rate limit atomicity under concurrent burst", () => {
  it("no more than limit requests are allowed across a burst of 10", async () => {
    const key = `concurrent-rl-${counter++}`;
    const limit = 4;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.resolve().then(() => checkRateLimit(key, limit, 60_000))
      )
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    // SQLite's atomic upsert serialises all increments — exactly limit are allowed
    expect(allowedCount).toBeLessThanOrEqual(limit);
    expect(allowedCount).toBe(limit);
  });

  it("remaining counter never goes below zero", async () => {
    const key = `concurrent-rl-neg-${counter++}`;
    const limit = 2;

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        Promise.resolve().then(() => checkRateLimit(key, limit, 60_000))
      )
    );

    expect(results.every((r) => r.remaining >= 0)).toBe(true);
  });
});
