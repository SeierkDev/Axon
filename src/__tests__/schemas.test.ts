import { describe, it, expect } from "vitest";
import {
  registerAgentSchema,
  updateAgentSchema,
  createTaskSchema,
  createBudgetSchema,
  createReviewSchema,
  createGatewaySchema,
  parseBody,
} from "@/lib/schemas";

// Solana system program address — 32 chars, all valid base58
const VALID_WALLET = "11111111111111111111111111111111";

describe("registerAgentSchema", () => {
  const valid = {
    agentId: "my-agent",
    name: "My Agent",
    capabilities: ["research"],
    publicKey: "pubkey123",
    walletAddress: VALID_WALLET,
  };

  it("accepts a minimal valid payload", () => {
    expect(registerAgentSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects invalid agentId characters", () => {
    const r = registerAgentSchema.safeParse({ ...valid, agentId: "my agent!" });
    expect(r.success).toBe(false);
  });

  it("rejects agentId longer than 80 chars", () => {
    const r = registerAgentSchema.safeParse({ ...valid, agentId: "a".repeat(81) });
    expect(r.success).toBe(false);
  });

  it("rejects empty capabilities array", () => {
    const r = registerAgentSchema.safeParse({ ...valid, capabilities: [] });
    expect(r.success).toBe(false);
  });

  it("rejects invalid provider", () => {
    const r = registerAgentSchema.safeParse({ ...valid, provider: "unknown-provider" });
    expect(r.success).toBe(false);
  });

  it("rejects non-URL endpoint", () => {
    const r = registerAgentSchema.safeParse({ ...valid, endpoint: "not-a-url" });
    expect(r.success).toBe(false);
  });

  it("accepts optional fields", () => {
    const r = registerAgentSchema.safeParse({
      ...valid,
      endpoint: "https://agent.example.com",
      price: "0.10 USDC",
      provider: "anthropic",
      providerModel: "claude-3",
    });
    expect(r.success).toBe(true);
  });
});

describe("updateAgentSchema", () => {
  it("accepts partial updates", () => {
    expect(updateAgentSchema.safeParse({ name: "New Name" }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ capabilities: ["coding"] }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ price: null }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ endpoint: null }).success).toBe(true);
  });

  it("rejects empty object", () => {
    const r = updateAgentSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe("createTaskSchema", () => {
  const valid = { from: "wallet123", to: "research-agent", task: "Summarize this article" };

  it("accepts a minimal valid payload", () => {
    expect(createTaskSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(createTaskSchema.safeParse({ to: "agent", task: "hello" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ from: "w", task: "hello" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ from: "w", to: "agent" }).success).toBe(false);
  });

  it("rejects task strings over 32 000 chars", () => {
    const r = createTaskSchema.safeParse({ ...valid, task: "x".repeat(32_001) });
    expect(r.success).toBe(false);
  });

  it("accepts context as a record", () => {
    const r = createTaskSchema.safeParse({ ...valid, context: { key: "value", nested: { a: 1 } } });
    expect(r.success).toBe(true);
  });
});

describe("createBudgetSchema", () => {
  it("accepts optional numeric limits", () => {
    expect(createBudgetSchema.safeParse({ maxPerCallUsdc: 1.5, maxPerDayUsdc: 10 }).success).toBe(true);
    expect(createBudgetSchema.safeParse({}).success).toBe(true);
  });

  it("rejects negative or zero values", () => {
    expect(createBudgetSchema.safeParse({ maxPerCallUsdc: 0 }).success).toBe(false);
    expect(createBudgetSchema.safeParse({ maxPerCallUsdc: -1 }).success).toBe(false);
  });

  it("rejects non-numeric values", () => {
    expect(createBudgetSchema.safeParse({ maxPerCallUsdc: "1.0" }).success).toBe(false);
  });
});

describe("createReviewSchema", () => {
  it("accepts valid ratings 1–5", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(createReviewSchema.safeParse({ rating }).success).toBe(true);
    }
  });

  it("rejects ratings outside 1–5", () => {
    expect(createReviewSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(createReviewSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(createReviewSchema.safeParse({ rating: -1 }).success).toBe(false);
  });

  it("rejects non-integer ratings", () => {
    expect(createReviewSchema.safeParse({ rating: 3.5 }).success).toBe(false);
  });

  it("rejects comments over 2000 chars", () => {
    const r = createReviewSchema.safeParse({ rating: 5, comment: "x".repeat(2001) });
    expect(r.success).toBe(false);
  });
});

describe("parseBody helper", () => {
  it("returns ok: true with typed data on success", () => {
    const result = parseBody({ rating: 4 }, createReviewSchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.rating).toBe(4);
  });

  it("returns ok: false with a 400 response on failure", () => {
    const result = parseBody({ rating: 0 }, createReviewSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it("includes field path in error message", async () => {
    const result = parseBody({ maxPerCallUsdc: -5 }, createBudgetSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await result.response.json() as { error: string };
      expect(body.error).toMatch(/maxPerCallUsdc/);
    }
  });
});

// ── registerAgentSchema: capabilities max-20 ─────────────────────────────────

describe("registerAgentSchema: capabilities cap", () => {
  it("rejects 21 capabilities (exceeds max of 20)", () => {
    const result = registerAgentSchema.safeParse({
      agentId: "agent-id",
      name: "Test Agent",
      capabilities: Array.from({ length: 21 }, (_, i) => `cap-${i}`),
      publicKey: "pk123",
      walletAddress: VALID_WALLET,
    });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 20 capabilities", () => {
    const result = registerAgentSchema.safeParse({
      agentId: "agent-id-20",
      name: "Test Agent",
      capabilities: Array.from({ length: 20 }, (_, i) => `cap-${i}`),
      publicKey: "pk123",
      walletAddress: VALID_WALLET,
    });
    expect(result.success).toBe(true);
  });
});

// ── parseBody: top-level refine error (path = []) ────────────────────────────

describe("parseBody: top-level refine error has no path prefix in message", () => {
  it("returns VALIDATION_ERROR with a message when schema refine fires at top level", async () => {
    // updateAgentSchema refines at the top level — error.path is [] (length 0)
    const result = parseBody({}, updateAgentSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json() as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    }
  });
});

// ── createGatewaySchema: injectHeaders 4 KB cap ───────────────────────────────

describe("createGatewaySchema: injectHeaders size cap", () => {
  it("rejects injectHeaders that serialize to more than 4 KB", () => {
    const result = createGatewaySchema.safeParse({
      name: "Provider",
      endpoint: "https://api.example.com/",
      ownerAgentId: "some-agent",
      injectHeaders: { "X-Key": "x".repeat(4090) },
    });
    expect(result.success).toBe(false);
  });
});
