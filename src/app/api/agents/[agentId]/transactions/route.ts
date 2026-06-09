import { NextRequest, NextResponse } from "next/server";
import { getPaymentsByAgent } from "@/lib/payments";
import { requireAgentOwner } from "@/lib/apiAuth";

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));
  const transactions = getPaymentsByAgent(agentId, limit);

  return NextResponse.json({ transactions, total: transactions.length });
}
