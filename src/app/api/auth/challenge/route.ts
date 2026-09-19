import { NextRequest, NextResponse } from "next/server";
import { createWalletChallenge } from "@/lib/identity";
import { normalizeAddress } from "@/lib/address";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`auth-challenge:${ip}`, 5, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const body = await req.json().catch(() => ({})) as { walletAddress?: string };

  if (!body.walletAddress) {
    return apiError("VALIDATION_ERROR", "walletAddress is required", 400);
  }

  const walletAddress = normalizeAddress(body.walletAddress);
  if (!walletAddress) {
    return apiError("VALIDATION_ERROR", "walletAddress must be a valid EVM address", 400);
  }

  // The challenge is the whole message rather than a bare nonce: it is both what the wallet
  // displays and what the signature is checked against, so the two cannot drift apart.
  const challenge = createWalletChallenge(walletAddress);

  return NextResponse.json(
    {
      walletAddress,
      challenge,
      expiresInSeconds: 300,
      instruction:
        "Sign the challenge string verbatim with personal_sign, then POST walletAddress, challenge and the 0x signature to /api/auth/verify",
    },
    { headers: rateLimitHeaders(rl, 5) }
  );
}
