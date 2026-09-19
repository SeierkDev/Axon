import { NextResponse } from "next/server";
import { getNetworkStats } from "@/lib/analytics";
import { getBurnStats } from "@/lib/burn";

export const dynamic = "force-dynamic";

export async function GET() {
  // awaited: the burn figures come off the chain now, and an un-awaited promise serialises to {}
  return NextResponse.json({ ...getNetworkStats(), burn: await getBurnStats() });
}
