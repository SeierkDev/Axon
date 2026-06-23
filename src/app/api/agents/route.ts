import { NextRequest, NextResponse, after } from "next/server";
import type { InferenceProvider } from "@/sdk/types";
import { createAgent, searchAgents, agentExists, categoryFromCapabilities } from "@/lib/agents";
import type { SortField } from "@/lib/agents";
import { semanticSearchAgents } from "@/lib/embeddings";
import { getVerifiedOwners } from "@/lib/ownerVerification";
import { requireApiKey } from "@/lib/apiAuth";
import { validatePublicHttpUrl } from "@/lib/urlSecurity";
import { parsePaymentAmount } from "@/lib/solana";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";
import { registerAgentSchema, parseBody } from "@/lib/schemas";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";
import { verifyAgentEndpoint } from "@/lib/verification";
import { notifyNewAgent } from "@/lib/telegram";

const VALID_SORT_FIELDS = new Set<string>(["reputation", "price", "createdAt", "activity", "successRate", "latency", "reviews"]);
const VALID_PROVIDERS: InferenceProvider[] = ["anthropic", "ollama", "openai"];

// Terms that would impersonate the Axon platform
const IMPERSONATION_TERMS = [
  "axon", "anthropic",
];

// Basic profanity / hate speech blocklist — extend as needed
const PROFANITY_TERMS = [
  "fuck", "shit", "cunt", "nigger", "nigga", "faggot", "retard",
  "bitch", "asshole", "bastard", "whore", "slut", "cock", "dick",
  "pussy", "rape", "nazi",
];

function isGibberish(str: string): boolean {
  const letters = str.toLowerCase().replace(/[^a-z]/g, "");
  if (letters.length === 0) return false;
  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  // Must have at least 1 vowel and 15% vowel ratio
  if (vowels === 0) return true;
  if (vowels / letters.length < 0.15) return true;
  // No run of more than 4 consecutive consonants — treat y as vowel (crypto, myth, gym)
  if (/[^aeiouy\s]{5,}/i.test(str.replace(/[^a-zA-Z\s]/g, ""))) return true;
  // q must be followed by u in real words
  if (/q[^u]/i.test(letters) || letters.endsWith("q")) return true;
  // Unusual consonant pairs that don't appear in real words
  if (/wq|qw|xq|bv|vb|jq|qj|zx|xz/i.test(letters)) return true;
  return false;
}

function validateAgentContent(name: string, agentId: string, capabilities: string[]): string | null {
  const haystack = [name, agentId, ...capabilities].join(" ").toLowerCase().replace(/[^a-z0-9 ]/g, " ");

  for (const term of PROFANITY_TERMS) {
    if (haystack.split(/\s+/).includes(term)) {
      return "Agent name or capabilities contain inappropriate language.";
    }
  }

  const nameLower = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const idLower = agentId.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const term of IMPERSONATION_TERMS) {
    const t = term.replace(/[^a-z0-9]/g, "");
    if (nameLower.includes(t) || idLower.includes(t)) {
      return `Agent name or ID must not impersonate '${term}' or other platforms.`;
    }
  }

  if (isGibberish(name)) {
    return "Agent name appears to be gibberish. Use a descriptive name like 'Legal Document Reviewer' or 'My Research Bot'.";
  }

  return null;
}

function parseLimit(raw: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback;
}

// GET /api/agents — search agents
// Supports ?q= for semantic search (requires OPENAI_API_KEY). Falls back to
// keyword search when the API key is absent or the embedding call fails.
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const q = searchParams.get("q")?.trim() || undefined;
  const minReputationRaw = searchParams.get("minReputation");
  const minReputation = minReputationRaw === null ? undefined : Number.parseFloat(minReputationRaw);
  const sort = searchParams.get("sort");
  const limit = parseLimit(searchParams.get("limit"), 50, 200);

  const sharedOpts = {
    capability: searchParams.get("capability") ?? undefined,
    capabilities: searchParams.get("capabilities")?.split(","),
    category: searchParams.get("category") ?? undefined,
    minReputation: Number.isFinite(minReputation) ? minReputation : undefined,
    maxPrice: searchParams.get("maxPrice") ?? undefined,
    limit,
  };

  if (q) {
    const semanticResults = await semanticSearchAgents(q, { ...sharedOpts, q });
    if (semanticResults !== null) {
      return NextResponse.json({ agents: tagOwnerVerified(semanticResults), semanticQuery: q });
    }
    // Fall through to keyword search if embeddings unavailable
  }

  const agents = searchAgents({
    ...sharedOpts,
    sort: sort && VALID_SORT_FIELDS.has(sort) ? sort as SortField : undefined,
  });

  return NextResponse.json({ agents: tagOwnerVerified(agents) });
}

// Tag each listed agent with whether its owner wallet is verified (one batched
// query), so the verified-owner badge is available to API/SDK consumers too —
// not just the marketplace page.
function tagOwnerVerified<T extends { agentId: string }>(agents: T[]): (T & { ownerVerified: boolean })[] {
  const verified = getVerifiedOwners(agents.map((a) => a.agentId));
  return agents.map((a) => ({ ...a, ownerVerified: verified.has(a.agentId) }));
}

// POST /api/agents — register a new agent
export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  // 10 registrations per wallet per minute; 20 per IP as a cross-wallet fallback
  const rl = checkRateLimit(`agents-register:${auth.user.walletAddress}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
  const ip = getClientIp(req);
  const ipRl = checkRateLimit(`agents-register-ip:${ip}`, 20, 60_000);
  if (!ipRl.allowed) return tooManyRequests(ipRl);

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const parsed = parseBody(raw, registerAgentSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (body.walletAddress !== auth.user.walletAddress) {
    return apiError(
      "FORBIDDEN",
      "walletAddress must match the authenticated API key owner",
      403
    );
  }

  if (agentExists(body.agentId)) {
    return apiError("CONFLICT", `Agent '${body.agentId}' is already registered`, 409);
  }

  const contentError = validateAgentContent(body.name, body.agentId, body.capabilities);
  if (contentError) return apiError("VALIDATION_ERROR", contentError, 400);

  if (body.provider && !VALID_PROVIDERS.includes(body.provider)) {
    return apiError(
      "VALIDATION_ERROR",
      `provider must be one of: ${VALID_PROVIDERS.join(", ")}`,
      400
    );
  }
  if (body.endpoint) {
    const endpointError = await validatePublicHttpUrl(body.endpoint);
    if (endpointError) return apiError("VALIDATION_ERROR", endpointError, 400);
  }
  if (body.providerEndpoint) {
    if ((body.provider ?? "anthropic") === "openai") {
      return apiError(
        "VALIDATION_ERROR",
        "providerEndpoint is not supported for openai because it would receive the server OpenAI API key",
        400
      );
    }
    const providerEndpointError = await validatePublicHttpUrl(body.providerEndpoint);
    if (providerEndpointError) {
      return apiError(
        "VALIDATION_ERROR",
        providerEndpointError.replace("endpoint", "providerEndpoint"),
        400
      );
    }
  }
  if (body.provider === "ollama" && !body.providerEndpoint) {
    return apiError(
      "VALIDATION_ERROR",
      "providerEndpoint is required for ollama agents and must be a public HTTP(S) endpoint",
      400
    );
  }


  const price = body.price?.trim() || undefined;
  const parsedPrice = price ? parsePaymentAmount(price) : null;
  if (price && (!parsedPrice || parsedPrice.amount <= 0)) {
    return apiError(
      "VALIDATION_ERROR",
      "price must look like '0.10 USDC' or '0.05 SOL'",
      400
    );
  }
  const capabilities = body.capabilities.map((cap) => cap.trim());

  const agent = createAgent({
    agentId: body.agentId,
    name: body.name,
    capabilities,
    publicKey: body.publicKey,
    endpoint: body.endpoint,
    price,
    category: body.category ?? categoryFromCapabilities(capabilities),
    walletAddress: body.walletAddress,
    provider: body.provider ?? "anthropic",
    providerModel: body.providerModel,
    providerEndpoint: body.providerEndpoint,
    reputation: 0,
    createdAt: new Date().toISOString(),
  });

  try {
    after(() => notifyNewAgent(agent.agentId, agent.name, capabilities));
  } catch {
    // outside Next.js request scope (e.g. tests) — skip
  }

  let endpointWarning: string | undefined;
  if (agent.endpoint) {
    const verification = await verifyAgentEndpoint(agent.agentId, agent.endpoint);
    if (verification.status === "unreachable") {
      endpointWarning = `Your endpoint (${agent.endpoint}) could not be reached. The agent is registered but will not appear in the marketplace until the endpoint is reachable. Check that your server is live and publicly accessible.`;
    }
  }

  recordAuditEvent({
    req,
    actor: auth.user,
    action: "agent.created",
    resourceType: "agent",
    resourceId: agent.agentId,
    ownerAgentId: agent.agentId,
    ownerWallet: agent.walletAddress,
    metadata: {
      provider: agent.provider,
      category: agent.category,
      priced: Boolean(agent.price),
      capabilities: agent.capabilities,
    },
  });

  return NextResponse.json(
    { ...agent, ...(endpointWarning ? { warning: endpointWarning } : {}) },
    { status: 201, headers: rateLimitHeaders(rl, 10) }
  );
}
