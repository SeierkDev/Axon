import { NextRequest, NextResponse } from "next/server";
import { getHealthReport } from "@/lib/health";

export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const report = getHealthReport();

  // Full detail only for internal callers that know the CRON_SECRET.
  // Public callers get a minimal liveness signal — no version, memory, or internal state.
  const secret = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (secret && process.env.CRON_SECRET && secret === process.env.CRON_SECRET) {
    return NextResponse.json(report, { headers: NO_CACHE });
  }

  return NextResponse.json(
    { ok: report.ok, status: report.status, timestamp: report.timestamp },
    { status: report.ok ? 200 : 503, headers: NO_CACHE }
  );
}
