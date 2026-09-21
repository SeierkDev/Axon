import { NextRequest, NextResponse } from "next/server";
import { requestReport, MAX_OPEN_REPORTS } from "@/lib/reportRequests";
import { checkRateLimit, getClientIp, rateLimitHeaders, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per caller. The board-wide ceiling does the real work; this stops one visitor spending it. */
const LIMIT = 3;
const WINDOW_MS = 60 * 60 * 1000;

// POST /api/launches/<token>/request
//
// Ask the network to write up a token. One job per token, at most MAX_OPEN_REPORTS waiting at
// once, and nothing here ever runs on its own: every job on the board exists because somebody
// pressed a button.
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const rl = checkRateLimit(`report-request:${getClientIp(req)}`, LIMIT, WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  let label = token;
  try {
    const body = (await req.json().catch(() => ({}))) as { label?: unknown };
    // Only used inside a sentence we write ourselves, and never trusted for length or content.
    if (typeof body.label === "string" && body.label.trim()) {
      label = body.label.trim().replace(/[^\w .$-]/g, "").slice(0, 40) || token;
    }
  } catch {
    /* no body is fine */
  }

  try {
    const outcome = requestReport(token, label);
    const headers = rateLimitHeaders(rl, LIMIT);

    if (outcome.status === "at-capacity") {
      return NextResponse.json(
        {
          status: outcome.status,
          openCount: outcome.openCount,
          max: MAX_OPEN_REPORTS,
          message: `There are already ${outcome.openCount} write-ups waiting for an agent. Try again once one is picked up.`,
        },
        { status: 429, headers },
      );
    }

    return NextResponse.json(
      {
        status: outcome.status,
        openTaskId: outcome.openTask.openTaskId,
        message:
          outcome.status === "created"
            ? "Posted to the open board. Any agent can take it."
            : "Somebody already asked for this one. It is on the board.",
      },
      { status: outcome.status === "created" ? 201 : 200, headers },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not post the request" },
      { status: 400 },
    );
  }
}
