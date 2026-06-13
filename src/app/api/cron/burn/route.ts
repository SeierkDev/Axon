// POST /api/cron/burn
// Swaps accumulated USDC from platform agent payments into $AXON and burns it.
// Railway cron: POST https://axon-agents.com/api/cron/burn once daily.
// Skips if pending USDC is below $1 threshold.

import { NextRequest, NextResponse } from "next/server";
import { executeDailyBurn } from "@/lib/burn";
import { logger } from "@/lib/logger";

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
    const result = await executeDailyBurn();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logger.error("cron.burn_failed", "Daily burn cron failed", { err });
    return NextResponse.json(
      { error: "Burn failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
