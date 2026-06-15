import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { logger } from "./logger";

export type TelegramPostType = "snapshot" | "agent" | "task_milestone" | "usdc_milestone" | "activity";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TASK_MILESTONES = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000];
const USDC_MILESTONES = [10, 50, 100, 250, 500, 1000, 5000, 10000];

async function sendMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHANNEL_ID?.trim();
  if (!token || !chatId) {
    logger.warn("telegram.not_configured", "TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID not set — skipping send");
    return false;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn("telegram.send_failed", "Telegram API returned non-2xx", { status: res.status, body });
    return false;
  }
  return true;
}

function storePost(type: TelegramPostType, content: string): void {
  getDb()
    .prepare(
      `INSERT INTO telegram_posts (post_id, type, content, created_at) VALUES (?, ?, ?, ?)`
    )
    .run(randomUUID(), type, content, new Date().toISOString());
}

export async function postToTelegram(type: TelegramPostType, text: string): Promise<boolean> {
  let sent = false;
  try {
    sent = await sendMessage(text);
  } catch (err) {
    logger.error("telegram.post_failed", "Failed to send Telegram message", { err });
    return false;
  }
  if (sent) {
    try {
      storePost(type, text);
    } catch (err) {
      logger.warn("telegram.store_failed", "Message sent but failed to store locally", { err });
    }
  }
  return sent;
}

export async function notifyNewAgent(
  _agentId: string,
  name: string,
  capabilities: string[]
): Promise<void> {
  try {
    const db = getDb();
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM agents")
      .get() as { count: number };

    const caps = capabilities.slice(0, 3).map(esc).join(", ");
    const text =
      `🤖 <b>New agent joined Axon</b>\n\n` +
      `<b>${esc(name)}</b>\n` +
      `Capabilities: ${caps}\n\n` +
      `Network now has <b>${count}</b> registered agents.\n\n` +
      `<a href="https://axon-agents.com/agents">Browse agents →</a>`;

    await postToTelegram("agent", text);
  } catch (err) {
    logger.error("telegram.notify_agent_failed", "Failed to post new-agent notification", { err });
  }
}

export async function checkAndPostMilestones(
  tasksCompleted: number,
  usdcTransacted: number
): Promise<void> {
  const db = getDb();

  // On first ever run, silently seed all already-passed milestones so we don't
  // flood the channel with historical catch-up posts.
  if (!db.prepare("SELECT 1 FROM telegram_milestones WHERE key = '_seeded'").get()) {
    const now = new Date().toISOString();
    for (const m of TASK_MILESTONES) {
      if (tasksCompleted >= m) {
        db.prepare(`INSERT OR IGNORE INTO telegram_milestones (key, value, announced_at) VALUES (?, ?, ?)`)
          .run(`tasks_${m}`, m, now);
      }
    }
    for (const m of USDC_MILESTONES) {
      if (usdcTransacted >= m) {
        db.prepare(`INSERT OR IGNORE INTO telegram_milestones (key, value, announced_at) VALUES (?, ?, ?)`)
          .run(`usdc_${m}`, m, now);
      }
    }
    db.prepare(`INSERT OR IGNORE INTO telegram_milestones (key, value, announced_at) VALUES (?, ?, ?)`)
      .run("_seeded", 1, now);
    return;
  }

  for (const milestone of TASK_MILESTONES) {
    if (tasksCompleted >= milestone) {
      const key = `tasks_${milestone}`;
      if (!db.prepare("SELECT 1 FROM telegram_milestones WHERE key = ?").get(key)) {
        const text =
          `📊 <b>Milestone: ${milestone.toLocaleString('en-US')} tasks completed</b>\n\n` +
          `Axon has now processed <b>${milestone.toLocaleString('en-US')}+</b> tasks across the network.\n\n` +
          `<a href="https://axon-agents.com/analytics">Live analytics →</a>`;
        const sent = await postToTelegram("task_milestone", text);
        if (sent) {
          db.prepare(
            `INSERT OR IGNORE INTO telegram_milestones (key, value, announced_at) VALUES (?, ?, ?)`
          ).run(key, milestone, new Date().toISOString());
        }
      }
    }
  }

  for (const milestone of USDC_MILESTONES) {
    if (usdcTransacted >= milestone) {
      const key = `usdc_${milestone}`;
      if (!db.prepare("SELECT 1 FROM telegram_milestones WHERE key = ?").get(key)) {
        const text =
          `💰 <b>$${milestone.toLocaleString('en-US')} USDC transacted on Axon</b>\n\n` +
          `$${milestone.toLocaleString('en-US')}+ USDC has now settled through the network.\n\n` +
          `<a href="https://axon-agents.com/analytics">Live analytics →</a>`;
        const sent = await postToTelegram("usdc_milestone", text);
        if (sent) {
          db.prepare(
            `INSERT OR IGNORE INTO telegram_milestones (key, value, announced_at) VALUES (?, ?, ?)`
          ).run(key, milestone, new Date().toISOString());
        }
      }
    }
  }
}

export async function postNetworkSnapshot(stats: {
  agentsTotal: number;
  agentsActive: number;
  tasksCompleted: number;
  successRate: number;
  usdcTransacted: number;
}): Promise<void> {
  // Deduplicate: skip if a snapshot was already posted in the last 30 minutes
  const recent = getDb()
    .prepare(`SELECT 1 FROM telegram_posts WHERE type = 'snapshot' AND created_at >= datetime('now', '-30 minutes') LIMIT 1`)
    .get();
  if (recent) return;

  const rate = Math.round(stats.successRate * 100);
  const text =
    `📡 <b>Axon Network — Live Update</b>\n\n` +
    `🤖 ${stats.agentsTotal} agents registered | ${stats.agentsActive} active\n` +
    `✅ ${stats.tasksCompleted.toLocaleString('en-US')} tasks completed | ${rate}% success rate\n` +
    `💵 $${stats.usdcTransacted.toFixed(2)} USDC transacted\n\n` +
    `<a href="https://axon-agents.com/analytics">Live analytics →</a>`;
  await postToTelegram("snapshot", text);
}

export async function postSingleTask(toAgent: string, success: boolean, failReason?: string): Promise<void> {
  const text = success
    ? `✅ <b>Task completed</b>\n\n<b>${esc(toAgent)}</b> successfully processed a task on Axon.\n\n<a href="https://axon-agents.com/analytics">Live analytics →</a>`
    : `❌ <b>Task failed</b>\n\n<b>${esc(toAgent)}</b> — ${esc(failReason ?? "Unknown error")}\n\n<a href="https://axon-agents.com/analytics">Live analytics →</a>`;
  await postToTelegram("activity", text);
}

export function getRecentPosts(
  limit = 20
): { post_id: string; type: string; content: string; created_at: string }[] {
  return getDb()
    .prepare("SELECT post_id, type, content, created_at FROM telegram_posts ORDER BY created_at DESC LIMIT ?")
    .all(limit) as { post_id: string; type: string; content: string; created_at: string }[];
}
