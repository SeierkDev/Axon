// GET /api/allowance: the allowance behind this key, read from the chain.
//
// Either kind of key may ask. An allowance key also gets its own limits and what it has spent today,
// which is what an assistant needs before it hires: how much it can still spend, and on whom.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { weiToDecimalString } from "@/lib/money";
import { allowancesEnabled, allowanceTokens, allowanceAddress, NATIVE_TOKEN, RESERVATION_TIMEOUT_SECONDS } from "@/lib/allowancePolicy";
import { readAccount } from "@/lib/allowanceChain";
import { getKeyLimits, keySpentTodayWei } from "@/lib/allowanceKeys";
import { isTransientRpcError } from "@/lib/evm";

const dec = (wei: bigint) => weiToDecimalString(wei);

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  if (!allowancesEnabled()) return NextResponse.json({ enabled: false });

  try {
    const accounts = await Promise.all(
      allowanceTokens().map(async (token) => {
        const a = await readAccount(auth.user.walletAddress, token);
        return {
          token: token === NATIVE_TOKEN ? "ETH" : "AXON",
          tokenAddress: token,
          configured: a.maxPerTask > 0n,
          available: dec(a.available),
          reserved: dec(a.reserved),
          maxPerTask: dec(a.maxPerTask),
          maxPerDay: dec(a.maxPerDay),
          spentToday: dec(a.spentToday),
          expiresAt: a.expiresAt > 0n ? new Date(Number(a.expiresAt) * 1000).toISOString() : null,
          paused: a.paused,
          restrictedToAllowedAgents: a.restrict,
        };
      }),
    );

    const limits = auth.user.scope === "allowance" ? getKeyLimits(auth.user.keyId) : null;
    return NextResponse.json({
      enabled: true,
      wallet: auth.user.walletAddress,
      // The owner's own transactions (deposit, rules, withdraw) go straight to this from their wallet.
      contract: allowanceAddress(),
      reclaimAfterSeconds: RESERVATION_TIMEOUT_SECONDS,
      accounts,
      ...(limits
        ? {
          key: {
            maxPerTask: dec(limits.maxPerTaskWei),
            maxPerDay: dec(limits.maxPerDayWei),
            spentToday: dec(keySpentTodayWei(auth.user.keyId)),
            allowedAgents: limits.allowedAgents,
            expiresAt: limits.expiresAt,
          },
        }
        : {}),
    });
  } catch (err) {
    return isTransientRpcError(err)
      ? apiError("UPSTREAM_ERROR", "The chain is not answering, try again shortly", 503)
      : apiError("INTERNAL_ERROR", "Could not read the allowance", 500);
  }
}
