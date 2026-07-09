import { NextRequest, NextResponse } from "next/server";
import { sampleReproducibility } from "@/lib/reproducibility";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// How many tasks one pass may reproduce — each costs a real model call, so the
// budget stays small; scheduled passes accumulate coverage over time.
const SAMPLE_LIMIT = 3;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

// POST /api/cron/reproducibility — continuous verification. Picks recent
// completed tasks without a proof, re-runs them, and pins the verdict on their
// receipts, so reproducibility accumulates across the network without anyone
// triggering it per task. Only work produced by a live model run is sampled.
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const samples = await sampleReproducibility(SAMPLE_LIMIT);
  if (samples.length > 0) {
    logger.info("reproducibility.sampled", "Reproducibility pass pinned verdicts", {
      count: samples.length,
      verdicts: samples.map((s) => `${s.taskId}:${s.verdict}`).join(","),
    });
  }
  return NextResponse.json({ ok: true, sampled: samples.length, samples });
}
