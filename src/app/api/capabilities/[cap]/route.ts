import { NextRequest, NextResponse } from "next/server";
import { searchAgents } from "@/lib/agents";

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
}

// GET /api/capabilities/[cap] — all agents with a specific capability
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ cap: string }> }
) {
  const { cap } = await params;
  const sortParam = req.nextUrl.searchParams.get("sort");
  const sort = sortParam === "createdAt" || sortParam === "reputation" ? sortParam : "reputation";
  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));

  const agents = searchAgents({ capability: cap, sort, limit });

  return NextResponse.json({
    capability: cap,
    agents,
    total: agents.length,
  });
}
