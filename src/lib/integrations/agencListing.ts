// AgenC cross-listing — an Axon agent, mirrored as a service listing on the
// AgenC marketplace protocol (opt-in, custodial v1).
//
// Everything here is deterministic and derived from the Axon agent itself:
// the AgenC agent id and listing id are SHA-256 of namespaced Axon ids, and the
// service spec hash uses AgenC's canonical job-spec form — the same scheme that
// pins Axon task specs. Verification runs the COMPLETE marketplace flow
// (register → list → attest → hire → complete) against AgenC's real compiled
// program in the litesvm sandbox; when their devnet Phase-2 redeploy lands the
// same derived ids go on-chain via config, no re-derivation.
//
// Axon settlement is untouched — this only makes agents discoverable/verifiable
// on AgenC's side.

import { createHash } from "crypto";
import { getDb } from "../db";
import { logger } from "../logger";
import { agencJobSpecHash } from "./agenc";
import type { Agent } from "@/sdk/types";

export type AgencListingStatus = "prepared" | "verified-sandbox" | "live";

export interface AgencListing {
  agentId: string;
  agencAgentId: string; // 32-byte id, hex
  listingId: string; // 32-byte id, hex
  specHash: string; // canonical service spec hash, hex
  cluster: string;
  agentAddress: string | null;
  listingAddress: string | null;
  status: AgencListingStatus;
  createdAt: string;
  updatedAt: string;
}

// Deterministic 32-byte ids in AgenC's id space, namespaced so an Axon agent
// can never collide with anything else we might derive later.
export function deriveAgencAgentId(agentId: string): string {
  return createHash("sha256").update(`axon-agent:${agentId}`, "utf8").digest("hex");
}
export function deriveAgencListingId(agentId: string): string {
  return createHash("sha256").update(`axon-listing:${agentId}`, "utf8").digest("hex");
}

// The canonical AgenC service spec for an Axon agent — what the listing's
// specHash commits to. Deterministic for a given agent id + name + price.
export function agentServiceSpec(agent: Pick<Agent, "agentId" | "name" | "price">) {
  return {
    from: "axon-network",
    to: agent.agentId,
    task: `service:${agent.name}`,
    context: { platform: "axon", listing: "cross-listed" },
    payment: agent.price?.trim() || null,
  };
}

// Convert "0.25 USDC"-style Axon prices to AgenC's integer price units
// (USDC has 6 decimals). Free agents list at 0.
export function priceToAgencUnits(price: string | null | undefined): bigint {
  const m = price?.trim().match(/^([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return 0n;
  const [whole, frac = ""] = m[1].split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

// Fixed-width byte fields for the on-chain listing (name/category 32, tags 64).
export function toFixedBytes(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(new TextEncoder().encode(text).slice(0, length));
  return out;
}

const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

interface Row {
  agent_id: string;
  agenc_agent_id: string;
  listing_id: string;
  spec_hash: string;
  cluster: string;
  agent_address: string | null;
  listing_address: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): AgencListing {
  return {
    agentId: row.agent_id,
    agencAgentId: row.agenc_agent_id,
    listingId: row.listing_id,
    specHash: row.spec_hash,
    cluster: row.cluster,
    agentAddress: row.agent_address,
    listingAddress: row.listing_address,
    status: row.status as AgencListingStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAgencListing(agentId: string): AgencListing | null {
  const row = getDb().prepare("SELECT * FROM agenc_listings WHERE agent_id = ?").get(agentId) as Row | undefined;
  return row ? fromRow(row) : null;
}

// Which of these agents are cross-listed (batched, for directory badges).
export function getAgencListedIds(agentIds: string[]): Set<string> {
  if (agentIds.length === 0) return new Set();
  const placeholders = agentIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT agent_id FROM agenc_listings WHERE agent_id IN (${placeholders})`)
    .all(...agentIds) as { agent_id: string }[];
  return new Set(rows.map((r) => r.agent_id));
}

function upsert(listing: Omit<AgencListing, "createdAt" | "updatedAt">): AgencListing {
  getDb()
    .prepare(
      `INSERT INTO agenc_listings (agent_id, agenc_agent_id, listing_id, spec_hash, cluster, agent_address, listing_address, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(agent_id) DO UPDATE SET
         agenc_agent_id = excluded.agenc_agent_id,
         listing_id = excluded.listing_id,
         spec_hash = excluded.spec_hash,
         cluster = excluded.cluster,
         agent_address = excluded.agent_address,
         listing_address = excluded.listing_address,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .run(
      listing.agentId,
      listing.agencAgentId,
      listing.listingId,
      listing.specHash,
      listing.cluster,
      listing.agentAddress,
      listing.listingAddress,
      listing.status,
    );
  return getAgencListing(listing.agentId)!;
}

// Cross-list an Axon agent on AgenC. In sandbox mode (the default) the listing
// flow — register agent, create service listing, moderation attest — executes
// against AgenC's real compiled program in-process and the derived PDAs are
// recorded (a full hire/complete round-trip is exercised separately in the
// agencInterop e2e test). If the sandbox isn't available (production runtime
// without the dev dependency), the listing is recorded as `prepared`: ids +
// spec hash are final either way, since they're deterministic.
export async function crossListAgent(agent: Agent): Promise<AgencListing> {
  const agencAgentId = deriveAgencAgentId(agent.agentId);
  const listingId = deriveAgencListingId(agent.agentId);
  const specHash = agencJobSpecHash(agentServiceSpec(agent));

  const base = {
    agentId: agent.agentId,
    agencAgentId,
    listingId,
    specHash,
    cluster: process.env.AGENC_CLUSTER ?? "sandbox",
    agentAddress: null as string | null,
    listingAddress: null as string | null,
    status: "prepared" as AgencListingStatus,
  };

  if (base.cluster !== "sandbox") {
    // devnet/mainnet paths activate after AgenC's Phase-2 redeploy — the ids
    // above are already the ones that will go on-chain.
    return upsert(base);
  }

  try {
    // Dynamic imports: the sandbox (litesvm) is a dev-only dependency.
    const [{ startLocalMarketplace }, sdk] = await Promise.all([
      import("@tetsuo-ai/marketplace-sdk/testing"),
      import("@tetsuo-ai/marketplace-sdk"),
    ]);
    const market = await startLocalMarketplace();
    const authority = await market.fundedSigner();
    const client = market.clientFor(authority);

    const idBytes = hexToBytes(agencAgentId);
    const listingBytes = hexToBytes(listingId);
    const specBytes = hexToBytes(specHash);

    await client.registerAgent({
      authority,
      agentId: idBytes,
      capabilities: 1n,
      endpoint: agent.endpoint ?? "https://axon.network",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [agentPda] = await sdk.findAgentPda({ agentId: idBytes });

    await client.createServiceListing({
      providerAgent: agentPda,
      authority,
      listingId: listingBytes,
      name: toFixedBytes(agent.name, 32),
      category: toFixedBytes(agent.category ?? "axon", 32),
      tags: toFixedBytes("axon,cross-listed", 64),
      specHash: specBytes,
      specUri: `agenc://job-spec/sha256/${specHash}`,
      price: priceToAgencUnits(agent.price),
      priceMint: null,
      requiredCapabilities: 1n,
      defaultDeadlineSecs: 3600n,
      maxOpenJobs: 0,
      operator: null,
      operatorFeeBps: 0,
    });
    const [listingPda] = await sdk.facade.findListingPda({ providerAgent: agentPda, listingId: listingBytes });
    await market.moderator.attestListing(listingPda, specBytes);

    return upsert({
      ...base,
      agentAddress: String(agentPda),
      listingAddress: String(listingPda),
      status: "verified-sandbox",
    });
  } catch (err) {
    // Expected in production (litesvm is a dev-only dependency) — the listing
    // is recorded as `prepared`; the derived ids are identical either way.
    // Logged so a genuine flow bug in dev doesn't hide behind this fallback.
    logger.warn("agenc.cross_list_sandbox_unavailable", "AgenC sandbox verification skipped", {
      agentId: agent.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return upsert(base);
  }
}
