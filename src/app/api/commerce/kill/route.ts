import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { killSwitch } from "@/lib/commerce";
import { recordAuditEvent } from "@/lib/audit";

export const runtime = "nodejs";

// POST /api/commerce/kill — stop all agent spending for this owner, now.
//
// Revokes every mandate, voids anything proposed or approved but not yet bought,
// and freezes the profiles. Deliberately takes no arguments and has no partial
// mode: the moment you want this, you want all of it. Deliberately not rate
// limited either — a panic button you have to wait for isn't one.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const result = killSwitch(auth.user.walletAddress);
    recordAuditEvent({
      req, actor: auth.user, action: "commerce.kill_switch",
      resourceType: "commerce", resourceId: auth.user.walletAddress,
      ownerWallet: auth.user.walletAddress, metadata: result,
    });
    return NextResponse.json({ stopped: true, ...result });
  });
}
