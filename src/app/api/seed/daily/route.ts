import { NextRequest, NextResponse } from "next/server";
import { runDailySeed } from "@/lib/seed";
import { apiError } from "@/lib/apiError";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.SEED_SECRET;
  if (!secret) {
    return apiError("INTERNAL_ERROR", "SEED_SECRET not configured", 503);
  }

  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return apiError("AUTH_REQUIRED", "Unauthorized", 401);
  }

  const body = await req.json().catch(() => ({})) as { taskCount?: number };
  const taskCount = Math.min(body.taskCount ?? 8, 30);

  const result = runDailySeed(taskCount);

  return NextResponse.json({
    ok: true,
    ...result,
    timestamp: new Date().toISOString(),
  });
}
