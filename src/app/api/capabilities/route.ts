import { NextResponse } from "next/server";
import { getAllCapabilities } from "@/lib/capabilities";

// GET /api/capabilities — list all capabilities with agent counts
export async function GET() {
  const capabilities = getAllCapabilities();
  return NextResponse.json({ capabilities, total: capabilities.length });
}
