import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  consumeWalletChallenge,
  createApiKey,
  verifyWalletSignature,
} from "@/lib/identity";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`auth-verify:${ip}`, 20, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const body = await req.json().catch(() => ({})) as {
    walletAddress?: string;
    challenge?: string;
    signature?: string;
  };

  if (!body.walletAddress || !body.challenge || !body.signature) {
    return apiError("VALIDATION_ERROR", "walletAddress, challenge, and signature are required", 400);
  }

  try {
    new PublicKey(body.walletAddress);
  } catch {
    return apiError("VALIDATION_ERROR", "walletAddress must be a valid Solana address", 400);
  }

  const verified = verifyWalletSignature({
    walletAddress: body.walletAddress,
    message: body.challenge,
    signatureB64: body.signature,
  });

  if (!verified) {
    return apiError("AUTH_REQUIRED", "Signature verification failed", 401);
  }

  // Consume only after the signature is valid so bad attempts cannot burn challenges.
  const validChallenge = consumeWalletChallenge(body.walletAddress, body.challenge);
  if (!validChallenge) {
    return apiError(
      "AUTH_REQUIRED",
      "Challenge is invalid or expired. Request a new one from /api/auth/challenge",
      401
    );
  }

  const apiKey = createApiKey(body.walletAddress);
  return NextResponse.json({
    walletAddress: body.walletAddress,
    apiKey: apiKey.apiKey,
    keyId: apiKey.keyId,
    keyPrefix: apiKey.keyPrefix,
  });
}
