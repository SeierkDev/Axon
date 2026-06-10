import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { createWalletChallenge } from "@/lib/identity";
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

  try {
    new PublicKey(body.walletAddress);
  } catch {
    return apiError("VALIDATION_ERROR", "walletAddress must be a valid Solana address", 400);
  }

  const challenge = createWalletChallenge(body.walletAddress);

  return NextResponse.json(
    {
      walletAddress: body.walletAddress,
      challenge,
      expiresInSeconds: 300,
      instruction: "Sign the challenge string with your Solana wallet and POST walletAddress, challenge, and base64 signature to /api/auth/login",
    },
    { headers: rateLimitHeaders(rl, 5) }
  );
}
