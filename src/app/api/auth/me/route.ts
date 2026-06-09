import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { getAllAgents } from "@/lib/agents";

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const agents = getAllAgents().filter(
    (agent) => agent.walletAddress === auth.user.walletAddress
  );

  return NextResponse.json({
    walletAddress: auth.user.walletAddress,
    keyId: auth.user.keyId,
    agents,
  });
}
