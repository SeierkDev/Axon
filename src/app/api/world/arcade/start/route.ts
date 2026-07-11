import { NextRequest, NextResponse } from "next/server";
import { startArcadeRun, ARCADE_MODES } from "@/lib/arcade";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// POST /api/world/arcade/start — open a run on the server's clock.
// The returned runId must accompany the finished run's submission: the server
// measures its own elapsed time between the two calls, so a leaderboard entry
// can't claim a time that wasn't actually lived. Public + rate-limited (a run
// token by itself ranks nothing — the submit is still wallet-gated).
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`arcade-start:${getClientIp(req)}`, 20, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
  const mode = typeof body.mode === "string" ? body.mode : "";
  if (!ARCADE_MODES[mode]) return NextResponse.json({ error: "unknown mode" }, { status: 400 });

  return NextResponse.json(startArcadeRun(mode));
}
