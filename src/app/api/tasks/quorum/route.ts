// POST /api/tasks/quorum
//
// Creates a quorum task that fans out the same prompt to N agents simultaneously.
// The result is accepted once `threshold` agents complete; the winning result is
// chosen from the highest-reputation completer. Ties broken by earliest completion.
//
// V1 constraint: all target agents must be free (no price). Paid quorum tasks
// require per-agent payment coordination and will be added in a future version.

import { NextRequest, NextResponse } from "next/server";
import { createQuorumRecord } from "@/lib/quorum";
import { createTask } from "@/lib/tasks";
import { getAgentById } from "@/lib/agents";
import { rankAgents } from "@/lib/routing";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { isValidSolanaAddress } from "@/lib/solana";
import { syncToTurso } from "@/lib/db-turso";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { recordAuditEvent } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { z } from "zod";
import { parseBody } from "@/lib/schemas";

const MIN_AGENTS = 2;
const MAX_AGENTS = 10;

const createQuorumSchema = z.object({
  from: z.string().min(1, "from is required"),
  // Explicit panel, OR omit and let the network assemble one from `capability`.
  agents: z
    .array(z.string().min(1))
    .min(MIN_AGENTS, `agents must contain at least ${MIN_AGENTS} entries`)
    .max(MAX_AGENTS, `agents must contain at most ${MAX_AGENTS} entries`)
    .optional(),
  // Quorum-by-default (Phase 11): the router assembles a panel of the top `count`
  // free agents for this capability, and the job settles on their consensus.
  capability: z.string().min(1).optional(),
  count: z.number().int().min(MIN_AGENTS).max(MAX_AGENTS).optional(),
  task: z
    .string()
    .min(1, "task is required")
    .max(32_000, "task must be 32 000 characters or fewer"),
  // Optional — defaults to a simple majority of the panel.
  threshold: z
    .number()
    .int("threshold must be a whole number")
    .min(1, "threshold must be at least 1")
    .optional(),
  context: z
    .record(z.string(), z.unknown())
    .refine((obj) => JSON.stringify(obj).length <= 50_000, "context must serialize to 50 KB or fewer")
    .optional(),
}).refine(
  (o) => (o.agents?.length ?? 0) >= MIN_AGENTS || !!o.capability,
  `provide \`agents\`, or a \`capability\` for the network to assemble the panel`,
);

export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  // Each quorum creates up to MAX_AGENTS tasks — use a tighter rate limit
  const ip = getClientIp(req);
  const rl = checkRateLimit(`quorum-create:${ip}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const parsed = parseBody(raw, createQuorumSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // Validate `from` and ownership
  if (body.from !== "anonymous" && !isValidSolanaAddress(body.from) && !getAgentById(body.from)) {
    return apiError("VALIDATION_ERROR", "from must be a valid Solana address or registered agent ID", 400);
  }
  if (!canAccessIdentity(auth.user, body.from)) {
    return apiError("FORBIDDEN", "from must be your wallet address or an agent owned by your wallet", 403);
  }

  // Resolve the panel. Explicit `agents`, or quorum-by-default: the router picks
  // the top `count` free agents for the capability (quorum V1 is free-only).
  let agentIds = body.agents;
  if (!agentIds) {
    const count = body.count ?? 3;
    // Weigh a wide candidate window before the free-only filter, so a panel isn't
    // starved just because the top of the ranking happens to be paid agents.
    const ranked = rankAgents({
      capability: body.capability,
      fromAgent: body.from !== "anonymous" ? body.from : undefined,
      candidateLimit: 40,
    });
    agentIds = ranked.filter((c) => !c.agent.price).map((c) => c.agent.agentId).slice(0, count);
    if (agentIds.length < MIN_AGENTS) {
      return apiError(
        "NO_AGENT_AVAILABLE",
        `Need at least ${MIN_AGENTS} free agents for "${body.capability}" to form a quorum — found ${agentIds.length}`,
        404,
      );
    }
  }

  // Default threshold to a simple majority of the panel.
  const threshold = body.threshold ?? Math.floor(agentIds.length / 2) + 1;

  // threshold must not exceed the number of agents
  if (threshold > agentIds.length) {
    return apiError(
      "VALIDATION_ERROR",
      `threshold (${threshold}) cannot exceed the number of agents (${agentIds.length})`,
      400
    );
  }

  // Validate all agents: must exist, be distinct, and be free (no price)
  const seen = new Set<string>();
  for (const agentId of agentIds) {
    if (seen.has(agentId)) {
      return apiError("VALIDATION_ERROR", `Duplicate agent ID: '${agentId}'`, 400);
    }
    seen.add(agentId);

    const agent = getAgentById(agentId);
    if (!agent) {
      return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
    }
    if (agent.price) {
      return apiError(
        "VALIDATION_ERROR",
        `Agent '${agentId}' requires payment (${agent.price}). Quorum tasks currently support free agents only.`,
        400
      );
    }
  }

  // Create the parent quorum record, then fan out one child task per agent.
  // If any createTask throws, roll back the quorum record and any partial tasks.
  const quorum = createQuorumRecord({
    fromAgent: body.from,
    taskContent: body.task,
    threshold,
    agentCount: agentIds.length,
  });

  const tasks = [];
  try {
    for (const agentId of agentIds) {
      tasks.push(
        createTask({
          fromAgent: body.from,
          toAgent: agentId,
          task: body.task,
          context: body.context,
          quorumId: quorum.quorumId,
          queueQueuedWebhook: true,
        })
      );
    }
  } catch (err) {
    const db = getDb();
    db.prepare("DELETE FROM tasks WHERE quorum_id = ?").run(quorum.quorumId);
    db.prepare("DELETE FROM quorum_tasks WHERE quorum_id = ?").run(quorum.quorumId);
    void syncToTurso();
    const msg = err instanceof Error ? err.message : "Failed to create child tasks";
    return apiError("INTERNAL_ERROR", msg, 500);
  }

  recordAuditEvent({
    req,
    actor: auth.user,
    action: "quorum.created",
    resourceType: "quorum",
    resourceId: quorum.quorumId,
    ownerWallet: auth.user.walletAddress,
    metadata: {
      threshold: quorum.threshold,
      agentCount: quorum.agentCount,
      agents: agentIds,
      autoAssembled: !body.agents,
    },
  });

  return NextResponse.json({ quorum, tasks }, { status: 201 });
}
