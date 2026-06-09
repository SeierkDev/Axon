import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export {};

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "axon-webhook-"));
  process.env.DATABASE_PATH = path.join(tempDir, "webhook.db");
  process.env.AXON_ALLOW_EPHEMERAL_DB = "true";
  process.env.LOG_LEVEL = "error";

  try {
    const { createAgent } = await import("../src/lib/agents");
    const { createWebhook, deliverPendingWebhooks, getWebhookById, retryDelivery } = await import("../src/lib/webhooks");
    const { getDb } = await import("../src/lib/db");

    const now = new Date().toISOString();
    const agentId = `smoke-agent-webhook-${Date.now()}`;
    createAgent({
      agentId,
      name: "Webhook Health Contract Agent",
      capabilities: ["testing"],
      publicKey: agentId,
      walletAddress: "11111111111111111111111111111111",
      provider: "anthropic",
      category: "Testing",
      reputation: 0,
      createdAt: now,
    });

    const webhook = createWebhook({
      agentId,
      url: "http://127.0.0.1:1/blocked",
      events: ["task.queued"],
    });

    getDb().prepare("UPDATE webhooks SET failure_count = 2 WHERE webhook_id = ?").run(webhook.webhookId);

    const deliveryId = randomUUID();
    getDb().prepare(`
      INSERT INTO webhook_deliveries
        (delivery_id, webhook_id, event_type, payload, status, attempts, next_attempt_at, created_at)
      VALUES (?, ?, 'task.queued', ?, 'pending', 4, ?, ?)
    `).run(
      deliveryId,
      webhook.webhookId,
      JSON.stringify({ event: "task.queued", timestamp: Math.floor(Date.now() / 1000), data: { taskId: "contract" } }),
      now,
      now
    );

    await deliverPendingWebhooks();

    const disabled = getWebhookById(webhook.webhookId);
    if (!disabled) throw new Error("Webhook disappeared after delivery");
    if (disabled.status !== "inactive") {
      throw new Error(`Webhook should be inactive after repeated failures, got ${disabled.status}`);
    }
    if (disabled.failureCount !== 3) {
      throw new Error(`Webhook failureCount should be 3, got ${disabled.failureCount}`);
    }
    if (!disabled.disabledAt || !disabled.disabledReason) {
      throw new Error("Disabled webhook is missing disabledAt/disabledReason");
    }

    if (!retryDelivery(deliveryId)) {
      throw new Error("Failed delivery retry should be accepted");
    }
    const reactivated = getWebhookById(webhook.webhookId);
    if (!reactivated) throw new Error("Webhook disappeared after retry");
    if (reactivated.status !== "active" || reactivated.failureCount !== 0) {
      throw new Error("Retry should reactivate webhook and clear failure count");
    }

    console.log(JSON.stringify({
      ok: true,
      webhookId: webhook.webhookId,
      deliveryId,
      disabledReason: disabled.disabledReason,
    }, null, 2));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
