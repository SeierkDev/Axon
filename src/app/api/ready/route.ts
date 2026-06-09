import { NextResponse } from "next/server";
import { getReadinessReport } from "@/lib/health";

export const runtime = "nodejs";

export async function GET() {
  const report = getReadinessReport();
  return NextResponse.json(report, {
    status: report.ok ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
