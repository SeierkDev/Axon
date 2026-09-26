// DELETE /api/allowance/keys/:keyId: revoke an allowance key. It stops working on the next request.
// Needs a full key from the wallet that owns it.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { revokeAllowanceKey } from "@/lib/allowanceKeys";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ keyId: string }> }) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const { keyId } = await params;
    if (!revokeAllowanceKey(keyId, auth.user.walletAddress)) {
      return apiError("NOT_FOUND", "Allowance key not found or does not belong to this wallet", 404);
    }
    return NextResponse.json({ ok: true });
  });
}
