// Tests for src/lib/webhooks.ts
// publicHttpFetch is mocked — no real HTTP calls are made

import { vi, describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";

// vi.mock is hoisted to the top of the file by vitest — synchronous factory required
vi.mock("@/lib/urlSecurity", () => ({
  publicHttpFetch: vi.fn(),
  validatePublicHttpUrl: vi.fn().mockResolvedValue(null),
}));

import { publicHttpFetch } from "@/lib/urlSecurity";
import {
  createWebhook,
  getWebhookById,
  getWebhookSecret,
  listWebhooks,
  deleteWebhook,
  queueWebhookEvent,
  deliverPendingWebhooks,
  retryDelivery,
  getFailedDeliveries,
  getDeliveriesByWebhook,
  getAgentIdByDeliveryId,
  getWebhookIdByDeliveryId,
} from "@/lib/webhooks";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let seq = 0;
function uid() { return `wh-${++seq}`; }

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const id = uid();
  return {
    agentId: id,
    name: `WH Agent ${id}`,
    capabilities: ["research"],
    publicKey: `pk-${id}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOkResponse(body = "ok"): Response {
  return { status: 200, text: () => Promise.resolve(body) } as unknown as Response;
}

function makeErrorResponse(status: number): Response {
  return { status, text: () => Promise.resolve("error") } as unknown as Response;
}

// Set a delivery's attempt count so the next sendDelivery call triggers permanent failure
function setAttempts(deliveryId: string, attempts: number) {
  getDb()
    .prepare("UPDATE webhook_deliveries SET attempts = ? WHERE delivery_id = ?")
    .run(attempts, deliveryId);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Pending deliveries from earlier tests in the same file share the DB and would
  // consume mock return values intended for later tests. Start each test clean.
  getDb().prepare("DELETE FROM webhook_deliveries").run();
});

// ── CRUD ──────────────────────────────────────────────────────────────────────

describe("createWebhook / getWebhookById", () => {
  it("creates a webhook and retrieves it by ID", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({
      agentId: a.agentId,
      url: "https://example.com/hook",
      events: ["task.completed"],
    });
    expect(wh.webhookId).toBeTruthy();
    expect(wh.status).toBe("active");
    expect(wh.agentId).toBe(a.agentId);
    expect(wh.events).toEqual(["task.completed"]);
    expect(wh.failureCount).toBe(0);
    expect(getWebhookById(wh.webhookId)).toMatchObject({ webhookId: wh.webhookId });
  });

  it("returns null for an unknown webhook ID", () => {
    expect(getWebhookById("no-such-id")).toBeNull();
  });
});

describe("getWebhookSecret", () => {
  it("returns the raw secret string for an existing webhook", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://s.example.com/", events: ["task.queued"] });
    const secret = getWebhookSecret(wh.webhookId);
    expect(typeof secret).toBe("string");
    expect(secret!.length).toBeGreaterThan(0);
    // Secret is not exposed on the Webhook object itself
    expect((wh as unknown as Record<string, unknown>).secret).toBeUndefined();
  });

  it("returns null for an unknown webhook ID", () => {
    expect(getWebhookSecret("unknown")).toBeNull();
  });
});

describe("listWebhooks", () => {
  it("returns all webhooks for an agent in descending creation order", () => {
    const a = makeAgent();
    createAgent(a);
    createWebhook({ agentId: a.agentId, url: "https://a1.example.com/", events: ["task.queued"] });
    createWebhook({ agentId: a.agentId, url: "https://a2.example.com/", events: ["task.completed"] });
    const list = listWebhooks(a.agentId);
    expect(list).toHaveLength(2);
    expect(list.every((w) => w.agentId === a.agentId)).toBe(true);
  });

  it("returns empty array for an agent with no webhooks", () => {
    const a = makeAgent();
    createAgent(a);
    expect(listWebhooks(a.agentId)).toEqual([]);
  });

  it("does not return webhooks from other agents", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);
    createWebhook({ agentId: a.agentId, url: "https://owner.example.com/", events: ["task.queued"] });
    expect(listWebhooks(b.agentId)).toHaveLength(0);
  });
});

describe("deleteWebhook", () => {
  it("removes the webhook row so it can no longer be retrieved", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://del.example.com/", events: ["task.failed"] });
    deleteWebhook(wh.webhookId);
    expect(getWebhookById(wh.webhookId)).toBeNull();
    expect(listWebhooks(a.agentId)).toHaveLength(0);
  });
});

// ── Event queueing ────────────────────────────────────────────────────────────

describe("queueWebhookEvent: no active webhooks", () => {
  it("is a no-op when the agent has no active webhooks", () => {
    const a = makeAgent();
    createAgent(a);
    queueWebhookEvent(a.agentId, "task.completed", { taskId: "t1" });
    expect(getFailedDeliveries(a.agentId)).toEqual([]);
  });
});

describe("queueWebhookEvent: event filter mismatch", () => {
  it("skips the webhook when the event type is not in its filter list", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({
      agentId: a.agentId,
      url: "https://filter.example.com/",
      events: ["task.queued"],
    });
    queueWebhookEvent(a.agentId, "task.completed", { taskId: "t2" });
    expect(getDeliveriesByWebhook(wh.webhookId)).toHaveLength(0);
  });
});

describe("queueWebhookEvent: matching event", () => {
  it("creates a pending delivery row with the correct event type", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({
      agentId: a.agentId,
      url: "https://match.example.com/",
      events: ["task.completed"],
    });
    queueWebhookEvent(a.agentId, "task.completed", { taskId: "t3" });
    const deliveries = getDeliveriesByWebhook(wh.webhookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].eventType).toBe("task.completed");
    expect(deliveries[0].status).toBe("pending");
    expect(deliveries[0].attempts).toBe(0);
    expect(deliveries[0].payload).toMatchObject({ event: "task.completed", data: { taskId: "t3" } });
  });

  it("creates one delivery per matching webhook on the same agent", () => {
    const a = makeAgent();
    createAgent(a);
    const wh1 = createWebhook({ agentId: a.agentId, url: "https://m1.example.com/", events: ["task.failed"] });
    const wh2 = createWebhook({ agentId: a.agentId, url: "https://m2.example.com/", events: ["task.failed"] });
    queueWebhookEvent(a.agentId, "task.failed", { taskId: "t4" });
    expect(getDeliveriesByWebhook(wh1.webhookId)).toHaveLength(1);
    expect(getDeliveriesByWebhook(wh2.webhookId)).toHaveLength(1);
  });

  it("skips inactive webhooks even if the event matches", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://inactive.example.com/", events: ["task.queued"] });
    getDb().prepare("UPDATE webhooks SET status = 'inactive' WHERE webhook_id = ?").run(wh.webhookId);
    queueWebhookEvent(a.agentId, "task.queued", { taskId: "t5" });
    expect(getDeliveriesByWebhook(wh.webhookId)).toHaveLength(0);
  });
});

// ── Delivery mechanics ────────────────────────────────────────────────────────

describe("deliverPendingWebhooks: 2xx success", () => {
  it("marks the delivery as delivered and resets the webhook failure count", async () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://ok.example.com/", events: ["payment.settled"] });
    queueWebhookEvent(a.agentId, "payment.settled", { amount: 1 });
    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeOkResponse());

    await deliverPendingWebhooks();

    const [d] = getDeliveriesByWebhook(wh.webhookId);
    expect(d.status).toBe("delivered");
    expect(d.responseStatus).toBe(200);
    expect(d.attempts).toBe(1);

    const updated = getWebhookById(wh.webhookId)!;
    expect(updated.failureCount).toBe(0);
    expect(updated.lastSuccessAt).toBeTruthy();
  });
});

describe("deliverPendingWebhooks: network error", () => {
  it("keeps the delivery pending and schedules a future retry", async () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://neterr.example.com/", events: ["task.queued"] });
    queueWebhookEvent(a.agentId, "task.queued", { taskId: "net-err" });
    vi.mocked(publicHttpFetch).mockRejectedValueOnce(new Error("connection refused"));

    await deliverPendingWebhooks();

    const [d] = getDeliveriesByWebhook(wh.webhookId);
    expect(d.status).toBe("pending");
    expect(d.attempts).toBe(1);
    expect(new Date(d.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("deliverPendingWebhooks: non-2xx response", () => {
  it("keeps the delivery pending, records the HTTP status, and schedules a retry", async () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://srv-err.example.com/", events: ["task.queued"] });
    queueWebhookEvent(a.agentId, "task.queued", { taskId: "500-err" });
    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeErrorResponse(500));

    await deliverPendingWebhooks();

    const [d] = getDeliveriesByWebhook(wh.webhookId);
    expect(d.status).toBe("pending");
    expect(d.attempts).toBe(1);
    expect(d.responseStatus).toBe(500);
    expect(new Date(d.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("deliverPendingWebhooks: MAX_ATTEMPTS exhausted", () => {
  it("marks delivery as failed and increments webhook failure_count", async () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://maxfail.example.com/", events: ["task.failed"] });
    queueWebhookEvent(a.agentId, "task.failed", { taskId: "max-fail" });

    const [d] = getDeliveriesByWebhook(wh.webhookId);
    // 4 previous attempts → attempt #5 will reach MAX_ATTEMPTS and permanently fail
    setAttempts(d.deliveryId, 4);
    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeErrorResponse(503));

    await deliverPendingWebhooks();

    const [updated] = getDeliveriesByWebhook(wh.webhookId);
    expect(updated.status).toBe("failed");
    expect(updated.responseStatus).toBe(503);
    expect(updated.attempts).toBe(5);

    const updatedWh = getWebhookById(wh.webhookId)!;
    expect(updatedWh.failureCount).toBe(1);
    expect(updatedWh.lastFailureAt).toBeTruthy();
    // One permanent failure is not enough to disable — still active
    expect(updatedWh.status).toBe("active");
  });
});

// ── MAX_PERMANENT_FAILURES: webhook disabled after 3 permanent failures ────────

describe("webhook disabled after MAX_PERMANENT_FAILURES", () => {
  it("sets webhook status to inactive after 3 permanently failed deliveries", async () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://disable.example.com/", events: ["task.failed"] });

    for (let i = 0; i < 3; i++) {
      queueWebhookEvent(a.agentId, "task.failed", { taskId: `perm-${i}` });
      const pending = getDeliveriesByWebhook(wh.webhookId).filter((d) => d.status === "pending");
      setAttempts(pending[0].deliveryId, 4);
      vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeErrorResponse(500));
      await deliverPendingWebhooks();
    }

    const updatedWh = getWebhookById(wh.webhookId)!;
    expect(updatedWh.status).toBe("inactive");
    expect(updatedWh.failureCount).toBeGreaterThanOrEqual(3);
    expect(updatedWh.disabledAt).toBeTruthy();
    expect(updatedWh.disabledReason).toBeTruthy();
  });
});

// ── retryDelivery ─────────────────────────────────────────────────────────────

describe("retryDelivery", () => {
  it("resets a failed delivery to pending and re-enables the webhook", async () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://retry.example.com/", events: ["task.completed"] });
    queueWebhookEvent(a.agentId, "task.completed", { taskId: "retry-me" });

    const [d] = getDeliveriesByWebhook(wh.webhookId);
    setAttempts(d.deliveryId, 4);
    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeErrorResponse(503));
    await deliverPendingWebhooks();

    expect(getDeliveriesByWebhook(wh.webhookId)[0].status).toBe("failed");

    const result = retryDelivery(d.deliveryId);
    expect(result).toBe(true);

    const [reset] = getDeliveriesByWebhook(wh.webhookId);
    expect(reset.status).toBe("pending");
    expect(reset.attempts).toBe(0);

    const updatedWh = getWebhookById(wh.webhookId)!;
    expect(updatedWh.status).toBe("active");
    expect(updatedWh.failureCount).toBe(0);
    expect(updatedWh.disabledAt).toBeUndefined();
  });

  it("returns false for a non-existent delivery ID", () => {
    expect(retryDelivery("no-such-delivery")).toBe(false);
  });

  it("returns false for a delivery that is already pending (not failed)", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://still-pending.example.com/", events: ["task.queued"] });
    queueWebhookEvent(a.agentId, "task.queued", { taskId: "still-pending" });
    const [d] = getDeliveriesByWebhook(wh.webhookId);
    // Already pending — retryDelivery only acts on 'failed' deliveries
    expect(retryDelivery(d.deliveryId)).toBe(false);
  });
});

// ── getFailedDeliveries ───────────────────────────────────────────────────────

describe("getFailedDeliveries", () => {
  it("returns permanently failed deliveries for the agent across all webhooks", async () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://gfd.example.com/", events: ["payment.refunded"] });
    queueWebhookEvent(a.agentId, "payment.refunded", { taskId: "gfd-1" });

    const [d] = getDeliveriesByWebhook(wh.webhookId);
    setAttempts(d.deliveryId, 4);
    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeErrorResponse(404));
    await deliverPendingWebhooks();

    const failed = getFailedDeliveries(a.agentId);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((fd) => fd.status === "failed")).toBe(true);
  });

  it("returns empty array when no failed deliveries exist", () => {
    const a = makeAgent();
    createAgent(a);
    expect(getFailedDeliveries(a.agentId)).toEqual([]);
  });

  it("excludes failed deliveries belonging to other agents", async () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);
    const wh = createWebhook({ agentId: a.agentId, url: "https://other.example.com/", events: ["task.failed"] });
    queueWebhookEvent(a.agentId, "task.failed", { taskId: "not-b" });
    const [d] = getDeliveriesByWebhook(wh.webhookId);
    setAttempts(d.deliveryId, 4);
    vi.mocked(publicHttpFetch).mockResolvedValueOnce(makeErrorResponse(500));
    await deliverPendingWebhooks();

    expect(getFailedDeliveries(b.agentId)).toEqual([]);
  });
});

// ── getDeliveriesByWebhook ────────────────────────────────────────────────────

describe("getDeliveriesByWebhook", () => {
  it("returns deliveries for the webhook ordered most recent first", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://dbw.example.com/", events: ["task.queued", "task.failed"] });
    queueWebhookEvent(a.agentId, "task.queued", { taskId: "d1" });
    queueWebhookEvent(a.agentId, "task.failed", { taskId: "d2" });
    const deliveries = getDeliveriesByWebhook(wh.webhookId);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.webhookId === wh.webhookId)).toBe(true);
  });

  it("respects the limit parameter", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://limit.example.com/", events: ["task.queued"] });
    for (let i = 0; i < 5; i++) {
      queueWebhookEvent(a.agentId, "task.queued", { taskId: `lim-${i}` });
    }
    expect(getDeliveriesByWebhook(wh.webhookId, 3)).toHaveLength(3);
  });

  it("returns empty array for a webhook with no deliveries", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://empty.example.com/", events: ["task.queued"] });
    expect(getDeliveriesByWebhook(wh.webhookId)).toEqual([]);
  });
});

// ── getAgentIdByDeliveryId / getWebhookIdByDeliveryId ─────────────────────────

describe("getAgentIdByDeliveryId", () => {
  it("returns the agent ID for a known delivery", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://agentlookup.example.com/", events: ["task.completed"] });
    queueWebhookEvent(a.agentId, "task.completed", { taskId: "al-1" });

    const [d] = getDeliveriesByWebhook(wh.webhookId);
    expect(getAgentIdByDeliveryId(d.deliveryId)).toBe(a.agentId);
  });

  it("returns null for an unknown delivery ID", () => {
    expect(getAgentIdByDeliveryId("no-such-delivery")).toBeNull();
  });
});

describe("getWebhookIdByDeliveryId", () => {
  it("returns the webhook ID for a known delivery", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://whlookup.example.com/", events: ["task.completed"] });
    queueWebhookEvent(a.agentId, "task.completed", { taskId: "wl-1" });

    const [d] = getDeliveriesByWebhook(wh.webhookId);
    expect(getWebhookIdByDeliveryId(d.deliveryId)).toBe(wh.webhookId);
  });

  it("returns null for an unknown delivery ID", () => {
    expect(getWebhookIdByDeliveryId("no-such-delivery")).toBeNull();
  });
});

// ── queueWebhookEvent: skips webhooks with malformed events JSON ───────────────

describe("queueWebhookEvent: malformed events JSON is skipped silently", () => {
  it("queues no deliveries when the only matching webhook has unparseable events", () => {
    const a = makeAgent();
    createAgent(a);
    const wh = createWebhook({ agentId: a.agentId, url: "https://badjson.example.com/", events: ["task.completed"] });

    // Corrupt the events column so JSON.parse throws
    getDb()
      .prepare("UPDATE webhooks SET events = 'bad-json' WHERE webhook_id = ?")
      .run(wh.webhookId);

    queueWebhookEvent(a.agentId, "task.completed", { taskId: "bj-1" });

    expect(getDeliveriesByWebhook(wh.webhookId)).toHaveLength(0);
  });
});
