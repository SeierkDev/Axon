// POST /api/cron/burn
// Forwards what the platform has earned to the Splitter, which feeds the burn.
// Railway cron: POST https://axon-agents.com/api/cron/burn.
// Skips when there is less queued than a transaction is worth.

import { NextRequest, NextResponse } from "next/server";
import { forwardEarningsToSplitter } from "@/lib/burn";
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
    const result = await forwardEarningsToSplitter();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logger.error("cron.burn_failed", "Burn forwarding cron failed", { err });
    return NextResponse.json(
      { error: "Forwarding failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
