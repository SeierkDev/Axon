import { NextRequest, NextResponse } from "next/server";
import { checkEligibility, launchFactoryAddress, LAUNCH_CHAIN_ID, MAX_DEV_BPS } from "@/lib/agentLaunch";
import { ponsLaunchFeeWei } from "@/lib/ponsFee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/agent-launch/<agentId>?wallet=0x…
//
// Whether this agent may launch a token, and whether the connected wallet is the one allowed to do it.
// Read-only: it answers a question, it never starts anything. The launch itself is two transactions signed
// by the user's own wallet, and nothing on the server can trigger either.
export async function GET(req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await ctx.params;
  const wallet = req.nextUrl.searchParams.get("wallet");

  const factory = launchFactoryAddress();
  const result = checkEligibility(agentId, wallet);
  // Asked of Pons rather than carried in the bundle, so a fee change does not turn every launch into a
  // revert in the wallet.
  const launchFeeWei = await ponsLaunchFeeWei();

  return NextResponse.json(
    {
      ...result,
      launchFeeWei: launchFeeWei.toString(),
      // Until the factory is deployed there is nothing to call, and the page says so rather than
      // offering a button that would fail in the wallet.
      factory,
      chainId: LAUNCH_CHAIN_ID,
      maxDevBps: MAX_DEV_BPS,
      eligible: result.eligible && Boolean(factory),
      reason: result.eligible && !factory ? "Launching is not switched on yet." : result.reason,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
