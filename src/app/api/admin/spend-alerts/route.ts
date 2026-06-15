import { NextRequest, NextResponse } from "next/server";
import { getRecentAlerts } from "@/lib/spendThreshold";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10) || 100, 500);

  const alerts = getRecentAlerts(limit);
  return NextResponse.json({ alerts, total: alerts.length });
}
