import { NextRequest, NextResponse } from "next/server";
import { getAvatar, saveAvatar, parseAvatar, isValidWallet } from "@/lib/worldAvatar";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

// GET /api/world/avatar?wallet=… — the saved avatar for a wallet (or null).
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? "";
  if (!isValidWallet(wallet)) {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
  }
  return NextResponse.json({ avatar: getAvatar(wallet) });
}

// POST /api/world/avatar — upsert the avatar for a wallet. Cosmetic; rate-limited.
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world-avatar:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const wallet = (body as { wallet?: string })?.wallet?.trim() ?? "";
  if (!isValidWallet(wallet)) {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
  }
  const avatar = parseAvatar((body as { avatar?: unknown })?.avatar);
  if (!avatar) {
    return NextResponse.json({ error: "invalid avatar" }, { status: 400 });
  }
  saveAvatar(wallet, avatar);
  return NextResponse.json({ ok: true }, { headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
