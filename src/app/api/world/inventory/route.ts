import { NextRequest, NextResponse } from "next/server";
import { getInventory, saveInventory, parseInventory, isValidWallet } from "@/lib/worldInventory";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

// GET /api/world/inventory?wallet=… — the saved minigame inventory for a wallet.
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? "";
  if (!isValidWallet(wallet)) {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
  }
  return NextResponse.json({ items: getInventory(wallet) });
}

// POST /api/world/inventory — upsert a wallet's inventory. Cosmetic; rate-limited.
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world-inventory:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
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
  const items = parseInventory((body as { items?: unknown })?.items);
  if (!items) {
    return NextResponse.json({ error: "invalid items" }, { status: 400 });
  }
  saveInventory(wallet, items);
  return NextResponse.json({ ok: true }, { headers: rateLimitHeaders(rl, RATE_LIMIT) });
}
