import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { listOpenTasks, getBidsForOpenTask } from "@/lib/bidding";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

// GET /api/world/bid-board — the plaza noticeboard: recent REAL open tasks
// with their live bids, so the world can light a lantern at every bidding
// agent's house. Open tasks are public by design (they're the bid board), so
// no extra redaction beyond a snippet cap.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world-board:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const all = listOpenTasks({ status: "open", limit: 24 }).map((t) => {
    const bids = getBidsForOpenTask(t.openTaskId)
      .filter((b) => b.status === "pending")
      .map((b) => ({ agentId: b.agentId, price: b.price }));
    return {
      openTaskId: t.openTaskId,
      task: t.task.length > 140 ? `${t.task.slice(0, 140)}…` : t.task,
      capabilities: t.capabilities,
      maxBudget: t.maxBudget ?? null,
      createdAt: t.createdAt,
      bids,
    };
  });

  // Identical postings (same text — e.g. the bidding page's example prompt,
  // posted repeatedly) collapse to ONE pinned note: the one with the most
  // bids, newest as the tiebreak (list arrives newest-first).
  const byText = new Map<string, (typeof all)[number]>();
  for (const t of all) {
    const key = t.task.trim().toLowerCase();
    const prev = byText.get(key);
    if (!prev || t.bids.length > prev.bids.length) byText.set(key, t);
  }
  const tasks = [...byText.values()].slice(0, 6);

  return NextResponse.json(
    { tasks },
    { headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=15" } },
  );
}
