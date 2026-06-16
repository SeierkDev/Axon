import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { buildAgentEmbeddingText, generateEmbedding, storeAgentEmbedding } from "@/lib/embeddings";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const agents = getDb()
    .prepare("SELECT agent_id, name, capabilities, category FROM agents WHERE embedding IS NULL")
    .all() as { agent_id: string; name: string; capabilities: string; category: string | null }[];

  if (agents.length === 0) {
    return NextResponse.json({ ok: true, backfilled: 0, message: "All agents already have embeddings" });
  }

  let backfilled = 0;
  const failed: string[] = [];

  for (const agent of agents) {
    let capabilities: string[] = [];
    try { capabilities = JSON.parse(agent.capabilities) as string[]; } catch { /* */ }

    const text = buildAgentEmbeddingText({ name: agent.name, capabilities, category: agent.category ?? undefined });
    const embedding = await generateEmbedding(text);

    if (embedding) {
      storeAgentEmbedding(agent.agent_id, embedding);
      backfilled++;
    } else {
      failed.push(agent.agent_id);
    }
  }

  return NextResponse.json({ ok: true, backfilled, failed, total: agents.length });
}
