import { NextResponse } from "next/server";
import { failureReport } from "@/lib/failurePatterns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/failures
//
// What has been going wrong lately and whether one cause has taken over. Public: it says nothing
// about who sent what, only what broke and how often, and a network that shows its own failure
// modes is easier to trust than one that only shows its wins.
//
// 200 normally, 503 when one cause owns most of the failures, so an uptime monitor watching this
// URL catches a platform-wide outage without anyone reading the body. The last one ran for three
// and a half weeks.
export async function GET() {
  const report = failureReport();
  return NextResponse.json(report, {
    status: report.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
