import { NextRequest } from "next/server";
import { getAgentById } from "@/lib/agents";
import { getProvider, getAgentSystem } from "@/lib/providers";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";

// 3 free test calls per IP per agent — 1 year window matches the tasks free demo limit
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_INPUT_CHARS = 500;
const TEST_MAX_TOKENS = 2048;

function sseEvent(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`test:${ip}:${agentId}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const agent = getAgentById(agentId);
  if (!agent) return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);

  if (agent.endpoint) {
    return apiError("NOT_SUPPORTED", "Test mode is not available for external endpoint agents", 422);
  }

  const body = await req.json().catch(() => null) as { task?: string } | null;
  if (!body?.task || typeof body.task !== "string" || !body.task.trim()) {
    return apiError("VALIDATION_ERROR", "task is required", 400);
  }

  const task = body.task.trim().slice(0, MAX_INPUT_CHARS);
  const start = Date.now();

  let provider: ReturnType<typeof getProvider>;
  try {
    provider = getProvider(agent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Provider unavailable";
    return apiError("UPSTREAM_ERROR", msg, 503);
  }

  const system = getAgentSystem(agent);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const text of provider.stream(system, task, TEST_MAX_TOKENS)) {
          controller.enqueue(sseEvent({ text }));
        }
        controller.enqueue(sseEvent({
          done: true,
          latencyMs: Date.now() - start,
          remaining: rl.remaining,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Test execution failed";
        controller.enqueue(sseEvent({ error: msg, code: "EXECUTION_ERROR" }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...rateLimitHeaders(rl, RATE_LIMIT),
    },
  });
}
