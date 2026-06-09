// GET /api/events
// Server-Sent Events stream for real-time task updates.
// Requires Authorization: Bearer <apiKey>.
// Emits: task.updated and task.progress for agents owned by the authenticated wallet.

import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { getDb } from "@/lib/db";
import { eventBus, type AxonEvent } from "@/lib/eventBus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sseChunk(event: AxonEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  // Resolve agent IDs owned by this wallet for event filtering
  const agentRows = getDb()
    .prepare("SELECT agent_id FROM agents WHERE wallet_address = ?")
    .all(auth.user.walletAddress) as { agent_id: string }[];
  const ownedAgentIds = new Set(agentRows.map((r) => r.agent_id));

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const onEvent = (event: AxonEvent) => {
        if (!ownedAgentIds.has(event.data.agentId)) return;
        try {
          controller.enqueue(sseChunk(event));
        } catch {
          clearInterval(keepalive);
          eventBus.off("*", onEvent);
        }
      };

      // Keepalive every 25s to survive proxy idle timeouts
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(keepalive);
          eventBus.off("*", onEvent);
        }
      }, 25_000);

      eventBus.on("*", onEvent);

      req.signal.addEventListener("abort", () => {
        clearInterval(keepalive);
        eventBus.off("*", onEvent);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
