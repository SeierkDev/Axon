import { NextRequest, NextResponse } from "next/server";
import { arcadeBoards, submitArcadeRun, ARCADE_MODES } from "@/lib/arcade";
import { holdsAxon, GATE_AMOUNT } from "@/lib/arcadeGate";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// GET /api/world/arcade?mode=climb — the mode's leaderboards (this week + all-time).
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`arcade-board:${getClientIp(req)}`, 60, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const mode = req.nextUrl.searchParams.get("mode") ?? "climb";
  if (!ARCADE_MODES[mode]) return NextResponse.json({ error: "unknown mode" }, { status: 400 });
  return NextResponse.json(arcadeBoards(mode), { headers: { "Cache-Control": "no-store" } });
}

// POST /api/world/arcade — record a finished run { mode, ms, player, wallet }.
// Client-reported times behind sanity bounds (casual leaderboard, no payouts).
// FREEMIUM GATE: playing is free; ranking requires the wallet to hold
// ≥ GATE_AMOUNT $AXON (balance verified on-chain, see arcadeGate.ts).
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`arcade-run:${getClientIp(req)}`, 12, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  let body: { mode?: string; ms?: number; player?: string; wallet?: string; runId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof body.wallet !== "string" || !body.wallet) {
    return NextResponse.json(
      { error: `connect a wallet holding ${GATE_AMOUNT.toLocaleString()} $AXON to rank`, gate: true },
      { status: 401 },
    );
  }
  if (!(await holdsAxon(body.wallet))) {
    return NextResponse.json(
      { error: `hold ${GATE_AMOUNT.toLocaleString()} $AXON to rank on the leaderboard`, gate: true },
      { status: 403 },
    );
  }

  // The run token is REQUIRED at the API boundary: the server timed this run
  // itself (see /api/world/arcade/start), so a submitted time has to line up
  // with wall-clock reality — and a token can never be spent twice.
  if (typeof body.runId !== "string" || !body.runId) {
    return NextResponse.json({ error: "missing run token — start the run before submitting it" }, { status: 400 });
  }

  try {
    const { rank } = submitArcadeRun({ mode: body.mode ?? "", player: body.player, ms: body.ms, runId: body.runId });
    return NextResponse.json({ rank, ...arcadeBoards(body.mode ?? "") });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "bad run" }, { status: 400 });
  }
}
