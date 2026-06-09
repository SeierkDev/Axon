import { NextResponse } from "next/server";
import { getNetworkStats } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getNetworkStats());
}
