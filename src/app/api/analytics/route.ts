import { NextResponse } from "next/server";
import { getNetworkStats } from "@/lib/analytics";
import { getBurnStats } from "@/lib/burn";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...getNetworkStats(), burn: getBurnStats() });
}
