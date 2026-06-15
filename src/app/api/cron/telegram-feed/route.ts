// POST /api/cron/telegram-feed
// Posts a network snapshot to the Axon Network Feed Telegram channel and checks
// for task/USDC milestones that haven't been announced yet.
// Railway cron: POST https://axon-agents.com/api/cron/telegram-feed every 2 hours.
// Secure with: Authorization: Bearer <CRON_SECRET>
import { NextRequest, NextResponse } from "next/server";
import { getNetworkStats } from "@/lib/analytics";
import { postNetworkSnapshot, checkAndPostMilestones } from "@/lib/telegram";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stats = getNetworkStats();
    await checkAndPostMilestones(stats.tasks.completed, stats.payments.totalUsdcTransacted);
    await postNetworkSnapshot({
      agentsTotal: stats.agents.total,
      agentsActive: stats.agents.active,
      tasksCompleted: stats.tasks.completed,
      successRate: stats.tasks.successRate,
      usdcTransacted: stats.payments.totalUsdcTransacted,
    });
    logger.info("cron.telegram_feed", "Telegram feed posted");
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("cron.telegram_feed_failed", "Telegram feed cron failed", { err });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
