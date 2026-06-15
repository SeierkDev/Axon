import { NextResponse } from "next/server";
import { getRecentPosts } from "@/lib/telegram";
import { getNetworkStats } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const posts = getRecentPosts(20);
  const stats = getNetworkStats();
  return NextResponse.json({
    posts,
    stats: {
      totalAgents: stats.agents.total,
      activeAgents: stats.agents.active,
      tasksCompleted: stats.tasks.completed,
      usdcTransacted: stats.payments.totalUsdcTransacted,
    },
  });
}
