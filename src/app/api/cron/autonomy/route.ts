// POST /api/cron/autonomy
//
// Tier 3: the pass over the live network. Observes the marketplace and applies
// price self-optimization to the agents whose owners opted in — and to no others.
//
// Railway cron: POST https://axon-agents.com/api/cron/autonomy, daily.
// GET runs the same pass without writing, so the result can be read before the
// pass is trusted to act.

import { NextRequest, NextResponse } from "next/server";
import { runNetworkPass, getLatestNetworkRun } from "@/lib/autonomyNetwork";

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
  const run = runNetworkPass({ apply: true });
  return NextResponse.json({
    runId: run.runId,
    agentsSeen: run.agentsSeen,
    observations: run.observations.length,
    changed: run.changes.length,
    changes: run.changes,
  });
}

// A dry pass, and the last recorded one. Public: it says what the network looks
// like, which is already public, and nothing about who owns what.
export async function GET() {
  const preview = runNetworkPass({ apply: false });
  return NextResponse.json(
    { preview, latest: getLatestNetworkRun() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
