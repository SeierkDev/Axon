import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { revokeApiKeyById } from "@/lib/identity";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ keyId: string }> }
) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const { keyId } = await params;
    const ok = revokeApiKeyById(keyId, auth.user.walletAddress);

    if (!ok) {
      return apiError("NOT_FOUND", "API key not found or does not belong to this wallet", 404);
    }

    return NextResponse.json({ ok: true });
  });
}
