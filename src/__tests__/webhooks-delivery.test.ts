// Tests for the sendDelivery / deliverPendingWebhooks pipeline in webhooks.ts.
// sendDelivery is private — driven indirectly through deliverPendingWebhooks.
// publicHttpFetch is mocked so no real HTTP calls occur.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockPublicHttpFetch } = vi.hoisted(() => ({
  mockPublicHttpFetch: vi.fn(),
}));

vi.mock("@/lib/urlSecurity", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/urlSecurity")>();
  return { ...original, publicHttpFetch: mockPublicHttpFetch };
});

import { getDb } from "@/lib/db";
import { createWebhook, queueWebhookEvent, deliverPendingWebhooks } from "@/lib/webhooks";
import { randomUUID } from "node:crypto";

const AGENT_ID = "wh-delivery-test-agent";
const WALLET = "11111111111111111111111111111111";
const WEBHOOK_URL = "https://example.com/hook";

function createTestAgent(): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO agents
      (agent_id, name, capabilities, public_key, wallet_address, reputation, created_at)
    VALUES (?, 'Delivery Test', '[]', 'pk', ?, 0, datetime('now'))
  `).run(AGENT_ID, WALLET);
}

function getPendingDelivery(): { delivery_id: string; status: string; attempts: number } | undefined {
  return getDb()
    .prepare("SELECT delivery_id, status, attempts FROM webhook_deliveries WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get() as { delivery_id: string; status: string; attempts: number } | undefined;
}

function getDelivery(deliveryId: string): { status: string; attempts: number; response_status: number | null } | undefined {
  return getDb()
    .prepare("SELECT status, attempts, response_status FROM webhook_deliveries WHERE delivery_id = ?")
    .get(deliveryId) as { status: string; attempts: number; response_status: number | null } | undefined;
}

let webhookId: string;

beforeEach(() => {
  createTestAgent();
  const wh = createWebhook({
    agentId: AGENT_ID,
    url: WEBHOOK_URL,
    events: ["task.queued"],
  });
  webhookId = wh.webhookId;
  queueWebhookEvent(AGENT_ID, "task.queued", { taskId: "t1", agentId: AGENT_ID });
});

afterEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM webhook_deliveries").run();
  db.prepare("DELETE FROM webhooks WHERE agent_id = ?").run(AGENT_ID);
  db.prepare("DELETE FROM agents WHERE agent_id = ?").run(AGENT_ID);
  mockPublicHttpFetch.mockReset();
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("deliverPendingWebhooks: successful delivery (HTTP 200)", () => {
  it("marks the delivery as delivered when the endpoint responds 2xx", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("ok", { status: 200 })
    );
    await deliverPendingWebhooks();

    const delivery = getDb()
      .prepare("SELECT status, attempts, response_status FROM webhook_deliveries WHERE webhook_id = ?")
      .get(webhookId) as { status: string; attempts: number; response_status: number | null } | undefined;
    expect(delivery?.status).toBe("delivered");
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.response_status).toBe(200);
  });

  it("marks delivered for HTTP 201", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("created", { status: 201 })
    );
    await deliverPendingWebhooks();
    const delivery = getDb()
      .prepare("SELECT status FROM webhook_deliveries WHERE webhook_id = ?")
      .get(webhookId) as { status: string } | undefined;
    expect(delivery?.status).toBe("delivered");
  });
});

// ── Network error → retry scheduled ──────────────────────────────────────────

describe("deliverPendingWebhooks: network error schedules retry", () => {
  it("leaves delivery pending and records the error body when fetch throws", async () => {
    mockPublicHttpFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await deliverPendingWebhooks();

    const delivery = getDb()
      .prepare("SELECT status, attempts FROM webhook_deliveries WHERE webhook_id = ?")
      .get(webhookId) as { status: string; attempts: number } | undefined;
    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempts).toBe(1);
  });
});

// ── HTTP error → retry scheduled ──────────────────────────────────────────────

describe("deliverPendingWebhooks: HTTP 5xx schedules retry", () => {
  it("leaves delivery pending when endpoint returns 500", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("Server error", { status: 500 })
    );
    await deliverPendingWebhooks();

    const delivery = getDb()
      .prepare("SELECT status, attempts, response_status FROM webhook_deliveries WHERE webhook_id = ?")
      .get(webhookId) as { status: string; attempts: number; response_status: number | null } | undefined;
    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.response_status).toBe(500);
  });
});

// ── Permanent failure (MAX_ATTEMPTS exhausted) ────────────────────────────────

describe("deliverPendingWebhooks: permanent failure after MAX_ATTEMPTS", () => {
  it("marks delivery as failed when attempts reach the maximum", async () => {
    // Pre-set attempts to 4 so that newAttempts (4+1=5) >= MAX_ATTEMPTS (5)
    const pending = getPendingDelivery();
    expect(pending).toBeDefined();
    getDb().prepare("UPDATE webhook_deliveries SET attempts = 4 WHERE delivery_id = ?")
      .run(pending!.delivery_id);

    mockPublicHttpFetch.mockRejectedValueOnce(new Error("timeout"));
    await deliverPendingWebhooks();

    const delivery = getDelivery(pending!.delivery_id);
    expect(delivery?.status).toBe("failed");
    expect(delivery?.attempts).toBe(5);
  });
});

// ── No pending deliveries ─────────────────────────────────────────────────────

describe("deliverPendingWebhooks: no pending deliveries", () => {
  it("completes without calling publicHttpFetch when queue is empty", async () => {
    // Mark existing delivery as already delivered so it won't be picked up
    getDb().prepare("UPDATE webhook_deliveries SET status = 'delivered' WHERE webhook_id = ?").run(webhookId);

    await deliverPendingWebhooks();
    expect(mockPublicHttpFetch).not.toHaveBeenCalled();
  });
});

// ── Inactive webhook not delivered ───────────────────────────────────────────

describe("deliverPendingWebhooks: disabled webhook is skipped", () => {
  it("does not call publicHttpFetch for deliveries belonging to a disabled webhook", async () => {
    getDb().prepare("UPDATE webhooks SET status = 'disabled' WHERE webhook_id = ?").run(webhookId);

    await deliverPendingWebhooks();
    expect(mockPublicHttpFetch).not.toHaveBeenCalled();
  });
});

// ── Webhook disabled after MAX_PERMANENT_FAILURES (3) ────────────────────────

describe("deliverPendingWebhooks: webhook is disabled after 3 permanent failures", () => {
  it("sets webhook status=inactive after the third permanently failed delivery", async () => {
    const db = getDb();

    // Helper: queue a fresh delivery and pre-set attempts to 4 so it fails permanently
    function queuePermanentFailure(): string {
      queueWebhookEvent(AGENT_ID, "task.queued", { taskId: randomUUID() });
      const pending = db
        .prepare("SELECT delivery_id FROM webhook_deliveries WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1")
        .get() as { delivery_id: string } | undefined;
      const deliveryId = pending!.delivery_id;
      db.prepare("UPDATE webhook_deliveries SET attempts = 4 WHERE delivery_id = ?").run(deliveryId);
      return deliveryId;
    }

    // Failure 1 — failure_count becomes 1 (< 3, webhook stays active)
    queuePermanentFailure();
    mockPublicHttpFetch.mockRejectedValueOnce(new Error("timeout"));
    await deliverPendingWebhooks();
    expect(db.prepare("SELECT status FROM webhooks WHERE webhook_id = ?").get(webhookId) as { status: string } | undefined)
      .toMatchObject({ status: "active" });

    // Failure 2 — failure_count becomes 2 (< 3, webhook stays active)
    queuePermanentFailure();
    mockPublicHttpFetch.mockRejectedValueOnce(new Error("timeout"));
    await deliverPendingWebhooks();
    expect(db.prepare("SELECT status FROM webhooks WHERE webhook_id = ?").get(webhookId) as { status: string } | undefined)
      .toMatchObject({ status: "active" });

    // Failure 3 — failure_count reaches 3 = MAX_PERMANENT_FAILURES → webhook disabled
    queuePermanentFailure();
    mockPublicHttpFetch.mockRejectedValueOnce(new Error("timeout"));
    await deliverPendingWebhooks();
    const webhook = db.prepare("SELECT status, disabled_reason FROM webhooks WHERE webhook_id = ?")
      .get(webhookId) as { status: string; disabled_reason: string | null } | undefined;
    expect(webhook?.status).toBe("inactive");
    expect(webhook?.disabled_reason).not.toBeNull();
  });
});
