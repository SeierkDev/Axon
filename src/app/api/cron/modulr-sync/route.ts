// POST /api/cron/modulr-sync
// Fetches approved tools from Modulr and registers any that aren't already in Axon.
// Railway cron: POST https://axon-agents.com/api/cron/modulr-sync every 30 minutes.
// Secure with: Authorization: Bearer <CRON_SECRET>

import { NextRequest, NextResponse } from "next/server";
import { agentExists, createAgent, categoryFromCapabilities } from "@/lib/agents";
import { verifyAgentEndpoint } from "@/lib/verification";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { InferenceProvider } from "@/sdk/types";

const MODULR_AGENTS_URL = "https://modulr402.com/api/axon/agents";

interface ModulrAgent {
  agentId: string;
  name: string;
  capabilities: string[];
  publicKey: string;
  walletAddress: string;
  endpoint?: string;
  price?: string;
  category?: string;
  provider?: string;
  providerModel?: string;
  providerEndpoint?: string;
  source?: string; // Modulr metadata — dropped before storing
}

interface ModulrResponse {
  protocol: string;
  source: string;
  updatedAt: string;
  count: number;
  agents: ModulrAgent[];
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let data: ModulrResponse;
  try {
    const res = await fetch(MODULR_AGENTS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Modulr API returned ${res.status}` },
        { status: 502 }
      );
    }
    data = await res.json() as ModulrResponse;
  } catch (err) {
    logger.warn("cron.modulr_sync_fetch_failed", "Failed to fetch Modulr agents", { err });
    return NextResponse.json({ error: "Failed to reach Modulr API" }, { status: 502 });
  }

  if (!Array.isArray(data.agents)) {
    return NextResponse.json({ error: "Invalid response from Modulr API" }, { status: 502 });
  }

  const results = { synced: [] as string[], skipped: [] as string[], failed: [] as string[] };

  for (const raw of data.agents) {
    if (!raw.agentId || !raw.name) {
      results.failed.push(raw.agentId ?? "unknown");
      continue;
    }

    if (agentExists(raw.agentId)) {
      // Ensure existing agents always carry the modulr badge
      getDb()
        .prepare("UPDATE agents SET verification_status = 'modulr' WHERE agent_id = ?")
        .run(raw.agentId);
      results.skipped.push(raw.agentId);
      continue;
    }

    try {
      // Drop Modulr-specific metadata before storing
      const { source: _source, ...agent } = raw;

      const now = new Date().toISOString();
      const created = createAgent({
        agentId: agent.agentId,
        name: agent.name,
        capabilities: agent.capabilities ?? [],
        publicKey: agent.publicKey ?? agent.walletAddress,
        walletAddress: agent.walletAddress,
        endpoint: agent.endpoint ?? undefined,
        price: agent.price ?? undefined,
        category: agent.category ?? categoryFromCapabilities(agent.capabilities ?? []),
        provider: (agent.provider ?? "anthropic") as InferenceProvider,
        providerModel: agent.providerModel ?? undefined,
        providerEndpoint: agent.providerEndpoint ?? undefined,
        reputation: 0,
        createdAt: now,
      });

      // Mark as Modulr partner before endpoint verification so badge shows immediately
      getDb()
        .prepare("UPDATE agents SET verification_status = 'modulr' WHERE agent_id = ?")
        .run(created.agentId);

      if (created.endpoint) {
        void verifyAgentEndpoint(created.agentId, created.endpoint);
      }

      results.synced.push(agent.agentId);
      logger.info("cron.modulr_sync_registered", "Registered Modulr agent", { agentId: agent.agentId });
    } catch (err) {
      logger.warn("cron.modulr_sync_register_failed", "Failed to register Modulr agent", { agentId: raw.agentId, err });
      results.failed.push(raw.agentId);
    }
  }

  logger.info("cron.modulr_sync_complete", "Modulr sync complete", results);

  return NextResponse.json({
    ok: true,
    updatedAt: data.updatedAt,
    total: data.agents.length,
    ...results,
  });
}
