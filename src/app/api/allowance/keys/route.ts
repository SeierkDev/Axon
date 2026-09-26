// GET  /api/allowance/keys: the wallet's allowance keys, with limits and what each spent today
// POST /api/allowance/keys: mint one. Returns the raw key once; it is never stored.
//
// Both need a full key: an allowance key cannot mint more of itself or see its siblings.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { decimalToWei, weiToDecimalString } from "@/lib/money";
import { createAllowanceKey, listAllowanceKeys, keyInputError, type AllowanceKeyInput } from "@/lib/allowanceKeys";
import { keyWarnings } from "@/lib/allowanceWatch";

const eth = (wei: bigint) => weiToDecimalString(wei);

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const keys = listAllowanceKeys(auth.user.walletAddress).map((k) => ({
    keyId: k.keyId,
    keyPrefix: k.keyPrefix,
    label: k.label,
    maxPerTask: eth(k.maxPerTaskWei),
    maxPerDay: eth(k.maxPerDayWei),
    spentToday: eth(k.spentTodayWei),
    allowedAgents: k.allowedAgents,
    expiresAt: k.expiresAt,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    // What in this key's recent spending looks like theft, if anything. Shown next to its Revoke.
    warnings: keyWarnings(k.keyId),
  }));
  return NextResponse.json({ keys });
}

export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const rl = checkRateLimit(`allowance-keys:${auth.user.walletAddress}`, 5, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const input: AllowanceKeyInput = {};
    if (raw.label !== undefined) {
      if (typeof raw.label !== "string") return apiError("VALIDATION_ERROR", "label must be a string", 400);
      input.label = raw.label;
    }
    for (const [field, target] of [["maxPerTask", "maxPerTaskWei"], ["maxPerDay", "maxPerDayWei"]] as const) {
      if (raw[field] === undefined) continue;
      const wei = typeof raw[field] === "string" ? decimalToWei(raw[field] as string) : null;
      if (wei === null) return apiError("VALIDATION_ERROR", `${field} must be an ETH amount like "0.0005"`, 400);
      input[target] = wei;
    }
    if (raw.allowedAgents !== undefined && raw.allowedAgents !== null) {
      if (!Array.isArray(raw.allowedAgents) || raw.allowedAgents.some((a) => typeof a !== "string")) {
        return apiError("VALIDATION_ERROR", "allowedAgents must be a list of agent ids", 400);
      }
      input.allowedAgents = raw.allowedAgents as string[];
    }
    if (raw.expiresInDays !== undefined) {
      if (typeof raw.expiresInDays !== "number") return apiError("VALIDATION_ERROR", "expiresInDays must be a number", 400);
      input.expiresInDays = raw.expiresInDays;
    }

    const error = keyInputError(input);
    if (error) return apiError("VALIDATION_ERROR", error, 400);

    const created = createAllowanceKey(auth.user.walletAddress, input);
    return NextResponse.json(
      {
        keyId: created.keyId,
        apiKey: created.apiKey,
        keyPrefix: created.keyPrefix,
        label: created.label,
        maxPerTask: eth(created.limits.maxPerTaskWei),
        maxPerDay: eth(created.limits.maxPerDayWei),
        allowedAgents: created.limits.allowedAgents,
        expiresAt: created.limits.expiresAt,
      },
      { status: 201 },
    );
  });
}
