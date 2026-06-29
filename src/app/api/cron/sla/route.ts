// POST /api/cron/sla
// Enforces SLA deadlines: any task whose deadline passed while still
// queued/running is auto-failed (the provider never delivered) and the client
// is refunded in full. Late-but-delivered tasks are penalized at settlement, not
// here. Secure with CRON_SECRET — set Authorization: Bearer <CRON_SECRET>.
// Railway cron: POST https://axon-agents.com/api/cron/sla every 1 min.

import { NextRequest, NextResponse } from "next/server";
import { enforceSlaDeadlines } from "@/lib/sla";

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
  const { breached } = enforceSlaDeadlines();
  return NextResponse.json({ ok: true, breached: breached.length, durationMs: Date.now() - start });
}
