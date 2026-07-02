// GET /api/build/status/<buildId>
// Lightweight progress poll for a background Axon Build run. Returns current
// per-agent steps and, once finished, the game HTML. Short request = immune to
// the HTTP/2 stream resets that killed the old long-lived SSE connection.

import { getBuildJob } from "@/lib/buildJobs";
import { getBuildGame } from "@/lib/buildStore";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ buildId: string }> }) {
  const { buildId } = await params;

  const job = getBuildJob(buildId);
  if (job) {
    return Response.json({
      buildId,
      steps: job.steps,
      done: job.done,
      passed: job.passed,
      // Only hand back HTML on a clean finish.
      html: job.done && !job.error ? job.html : undefined,
      error: job.error ?? undefined,
    });
  }

  // No job row (pruned after TTL) — recover the finished game from persistence
  // so a reconnect still gets its result.
  const game = getBuildGame(buildId);
  if (game) {
    return Response.json({
      buildId,
      steps: {},
      done: true,
      passed: game.qaPassed,
      html: game.html,
    });
  }

  // Unknown build — still building on another instance with no persisted game
  // yet, or an invalid id. Report not-done so the client keeps polling briefly.
  return Response.json({ buildId, steps: {}, done: false, unknown: true });
}
