import { NextResponse } from "next/server";
import { getFeePolicy } from "@/lib/feePolicy";

// GET /api/fee-policy — the platform's published fee policy (public).
export async function GET() {
  return NextResponse.json(getFeePolicy());
}
