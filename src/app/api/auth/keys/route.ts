import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { listApiKeys, createApiKey } from "@/lib/identity";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  return NextResponse.json({ keys: listApiKeys(auth.user.walletAddress) });
}

// POST /api/auth/keys — create a new API key for the authenticated wallet
// Rate-limited to 5 keys per wallet per minute to prevent key-farming.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    // Per-wallet limit: 5 new keys per minute
    const rl = checkRateLimit(`auth-keys:${auth.user.walletAddress}`, 5, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    // Per-IP fallback: 10 key creations per minute regardless of wallet
    const ip = getClientIp(req);
    const ipRl = checkRateLimit(`auth-keys-ip:${ip}`, 10, 60_000);
    if (!ipRl.allowed) return tooManyRequests(ipRl);

    const result = createApiKey(auth.user.walletAddress);
    // Return the raw key once — callers must store it immediately
    return NextResponse.json(
      { keyId: result.keyId, apiKey: result.apiKey, keyPrefix: result.keyPrefix },
      { status: 201 }
    );
  });
}
