import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { createCommerceProfile, listCommerceProfiles, forgetCommerceProfile } from "@/lib/commerce";
import { commerceProfileSchema, parseBody } from "@/lib/schemas";

export const runtime = "nodejs";

// Where a buyer's orders ship, and who they're for. Owned by a wallet, never by
// an agent — an agent is granted the capability to spend, never the details.
//
// GET  /api/commerce/profiles — this owner's profiles (no PII in the response)
// POST /api/commerce/profiles — store contact + address, encrypted at rest

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ profiles: listCommerceProfiles(auth.user.walletAddress) });
}

// DELETE /api/commerce/profiles?id=<profileId> — erase the stored details.
//
// Scrubs the encrypted contact and address and revokes any mandate spending
// against it. Purchase records are kept: they hold no personal data, and "forget
// my address" is not the same request as "destroy my spend history".
export async function DELETE(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const profileId = req.nextUrl.searchParams.get("id")?.trim();
    if (!profileId) return apiError("VALIDATION_ERROR", "id is required", 400);

    const forgotten = forgetCommerceProfile(profileId, auth.user.walletAddress);
    if (!forgotten) {
      return apiError("NOT_FOUND", `Profile '${profileId}' not found, or already erased`, 404);
    }
    return NextResponse.json({ profileId, forgotten: true });
  });
}

export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const rl = checkRateLimit(`commerce-profile:${auth.user.walletAddress}`, 10, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const raw = await req.json().catch(() => null);
    const parsed = parseBody(raw, commerceProfileSchema);
    if (!parsed.ok) return parsed.response;

    try {
      const profile = createCommerceProfile({
        ownerWallet: auth.user.walletAddress,
        label: parsed.data.label,
        contact: parsed.data.contact,
        address: parsed.data.address,
      });
      // Deliberately returns the public shape: the contact and address are write-only
      // from here on, readable only by the checkout call that needs them.
      return NextResponse.json(profile, { status: 201 });
    } catch (err) {
      return apiError("INTERNAL_ERROR", err instanceof Error ? err.message : "could not store the profile", 500);
    }
  });
}
