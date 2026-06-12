import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { key } = await req.json().catch(() => ({})) as { key?: string };
  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const result = getDb()
    .prepare("DELETE FROM rate_limit_windows WHERE key LIKE ?")
    .run(`%${key}%`);

  return NextResponse.json({ ok: true, deleted: result.changes });
}
