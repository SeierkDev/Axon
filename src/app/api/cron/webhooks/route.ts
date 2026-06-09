// POST /api/cron/webhooks
// Flushes all pending webhook deliveries (with exponential-backoff retries).
// Secure with CRON_SECRET env var — set Authorization: Bearer <CRON_SECRET> in your cron caller.
// Railway cron: POST https://axon-agents.com/api/cron/webhooks every 1 min.

import { NextRequest, NextResponse } from "next/server";
import { deliverPendingWebhooks } from "@/lib/webhooks";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  // Require the secret in production; allow open access only during local dev.
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const start = Date.now();
  await deliverPendingWebhooks();
  return NextResponse.json({ ok: true, durationMs: Date.now() - start });
}
