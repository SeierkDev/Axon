import { NextRequest, NextResponse } from "next/server";
import { runBurnEngine } from "@/lib/burnEngine";

export const runtime = "nodejs";
export const maxDuration = 300;

// POST /api/cron/burn-engine
//
// Sweeps the creator tax off the curve into the Splitter, then burns if a burn is due. Both calls
// are permissionless on-chain; this holds the key that pays the gas for them.
//
// Railway cron, every five minutes. The pot's own interval is thirty, so running more often does
// not burn more often: it only means a burn fires soon after it becomes allowed instead of up to
// half an hour late. A pass with nothing to do costs one read and no gas.
//
// Always 200 with a report. The pot reverts for ordinary reasons all day (TooSoon, TooSmall,
// MarketNotReady) and a non-2xx for those would make the cron service look crashed every run.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Also make sure the fast loop is alive, in this process.
  //
  // It is started from instrumentation, which Next loads in its own module graph: the loop was
  // running there while the code serving requests held a different copy of the module that had
  // never started anything. Every burn so far was fired by this cron at one minute, not by the
  // loop at five seconds, and nothing said so until there was something watching.
  //
  // Starting it from here puts it in the process that actually handles requests. It is
  // idempotent, so the call after the first does nothing, and this route already runs every
  // minute, which makes the loop self-healing across restarts.
  try {
    const { startBurnLoop } = await import("@/lib/burnLoop");
    startBurnLoop();
  } catch {
    /* the cron pass below is the fallback, and it is about to run anyway */
  }

  return NextResponse.json(await runBurnEngine());
}

// A dry read of the same state, so the schedule can be checked without the key doing anything.
export async function GET() {
  const { burnPotAddress } = await import("@/lib/burn");
  const { getBurnLive } = await import("@/lib/burnLive");
  const pot = burnPotAddress();
  if (!pot) return NextResponse.json({ configured: false, reason: "AXON_BURN_POT_ADDRESS is not set" });
  const live = await getBurnLive();
  return NextResponse.json(
    {
      configured: true,
      hasKey: Boolean(process.env.BOT_PRIVATE_KEY?.trim()),
      launched: live.launched,
      ready: live.ready,
      nextBurnAt: live.nextBurnAt,
      nextBurnEth: live.nextBurnEth,
      potBalanceEth: live.potBalanceEth,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
