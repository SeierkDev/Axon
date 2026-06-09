import { NextResponse } from "next/server";
import { getHealthReport } from "@/lib/health";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getHealthReport(), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
