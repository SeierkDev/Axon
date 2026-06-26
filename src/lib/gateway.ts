// Provider Gateway — wraps any external HTTP API with Axon payment metering.
// Developers register their endpoint + price; Axon proxies paid requests to it.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { publicHttpFetch } from "./urlSecurity";
import { encrypt, decrypt } from "./crypto";
import { logger } from "./logger";
import { recordEndpointCheck } from "./endpointUptime";

// ── Per-provider circuit breaker ──────────────────────────────────────────────
// Each gateway provider gets its own circuit. One broken upstream cannot block
// calls to other providers. Thresholds are more aggressive than Helius because
// gateway providers are third-party and less reliable.

const GATEWAY_FAILURE_THRESHOLD = 3;    // open after 3 consecutive failures
const GATEWAY_RECOVERY_WINDOW_MS = 30_000; // stay open for 30 s before probing

type GatewayCircuitState = "closed" | "open" | "half-open";

interface GatewayCircuit {
  state: GatewayCircuitState;
  failures: number;
  openedAt: number | null;
}

const _gatewayCircuits = new Map<string, GatewayCircuit>();

function getCircuit(providerId: string): GatewayCircuit {
  let circuit = _gatewayCircuits.get(providerId);
  if (!circuit) {
    circuit = { state: "closed", failures: 0, openedAt: null };
    _gatewayCircuits.set(providerId, circuit);
  }
  return circuit;
}

function advanceGatewayCircuit(circuit: GatewayCircuit): GatewayCircuitState {
  if (circuit.state === "open" && circuit.openedAt !== null) {
    if (Date.now() - circuit.openedAt >= GATEWAY_RECOVERY_WINDOW_MS) {
      circuit.state = "half-open";
      circuit.failures = 0;
    }
  }
  return circuit.state;
}

export class GatewayCircuitOpenError extends Error {
  readonly providerId: string;
  readonly retryAfterMs: number;
  constructor(providerId: string, retryAfterMs: number) {
    super(`Gateway circuit open for provider ${providerId} — retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "GatewayCircuitOpenError";
    this.providerId = providerId;
    this.retryAfterMs = retryAfterMs;
  }
}

function recordGatewaySuccess(providerId: string): void {
  const circuit = getCircuit(providerId);
  circuit.state = "closed";
  circuit.failures = 0;
  circuit.openedAt = null;
}

function recordGatewayFailure(providerId: string, providerName: string): void {
  const circuit = getCircuit(providerId);
  circuit.failures++;
  if (circuit.state === "half-open" || circuit.failures >= GATEWAY_FAILURE_THRESHOLD) {
    const alreadyOpen = circuit.state === "open";
    circuit.state = "open";
    // Only stamp openedAt on the first opening — never reset it while already open,
    // otherwise concurrent in-flight requests would extend the recovery window.
    if (!alreadyOpen) {
      circuit.openedAt = Date.now();
      logger.error("gateway.circuit_opened", "Gateway circuit breaker opened — provider is failing", {
        providerId,
        providerName,
        consecutiveFailures: circuit.failures,
        recoveryWindowMs: GATEWAY_RECOVERY_WINDOW_MS,
      });
    }
  }
}

export function getGatewayCircuitState(providerId: string): { state: GatewayCircuitState; consecutiveFailures: number } {
  const circuit = getCircuit(providerId);
  advanceGatewayCircuit(circuit);
  return { state: circuit.state, consecutiveFailures: circuit.failures };
}

export function resetGatewayCircuit(providerId: string): void {
  _gatewayCircuits.delete(providerId);
}

// Headers that must never be forwarded to upstream APIs
const BLOCKED_UPSTREAM_HEADERS = new Set([
  "host",
  "x-payment",
  "x-payment-required",
  "x-axon-signature",
  "x-axon-event",
  "x-axon-delivery",
  "x-axon-timestamp",
  "authorization", // caller's auth — never leak to upstream
  "cookie",
]);

const DEFAULT_PRICE_PER_CALL = "0.10 USDC";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GatewayProvider {
  providerId: string;
  name: string;
  endpoint: string;
  method: string;
  forwardHeaders: string[];   // header names to pass through from the client request
  injectHeaders: Record<string, string>; // headers always added to upstream request (e.g. API keys)
  pricePerCall: string;
  description?: string;
  ownerAgentId?: string;
  timeoutMs: number;
  status: "active" | "inactive";
  createdAt: string;
}

export interface GatewayCallResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

interface GatewayRow {
  provider_id: string;
  name: string;
  endpoint: string;
  method: string;
  forward_headers: string;
  inject_headers: string;
  price_per_call: string;
  description: string | null;
  owner_agent_id: string | null;
  timeout_ms: number;
  status: string;
  created_at: string;
}

function safeParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

// inject_headers are stored AES-256-GCM encrypted (enc1: prefix).
// Rows written before encryption are still parsed as plain JSON — backwards compatible.
function decryptInjectHeaders(raw: string): Record<string, string> {
  if (raw.startsWith("enc1:")) {
    try {
      return JSON.parse(decrypt(raw.slice(5))) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return safeParse<Record<string, string>>(raw, {});
}

function encryptInjectHeaders(headers: Record<string, string>): string {
  if (!process.env.SEED_SECRET) {
    // In production SEED_SECRET must always be set — this path means inject_headers
    // are stored as plaintext, which leaks upstream API keys from the DB.
    if (process.env.NODE_ENV === "production") {
      throw new Error("SEED_SECRET is required in production to encrypt gateway inject_headers");
    }
    return JSON.stringify(headers);
  }
  return `enc1:${encrypt(JSON.stringify(headers))}`;
}

function rowToProvider(row: GatewayRow): GatewayProvider {
  return {
    providerId: row.provider_id,
    name: row.name,
    endpoint: row.endpoint,
    method: row.method,
    forwardHeaders: safeParse<string[]>(row.forward_headers, []),
    injectHeaders: decryptInjectHeaders(row.inject_headers),
    pricePerCall: row.price_per_call,
    description: row.description ?? undefined,
    ownerAgentId: row.owner_agent_id ?? undefined,
    timeoutMs: row.timeout_ms,
    status: row.status as GatewayProvider["status"],
    createdAt: row.created_at,
  };
}

export function normalizeGatewayPrice(pricePerCall?: string): string {
  const price = pricePerCall?.trim();
  return price ? price : DEFAULT_PRICE_PER_CALL;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createGatewayProvider(opts: {
  name: string;
  endpoint: string;
  method?: string;
  forwardHeaders?: string[];
  injectHeaders?: Record<string, string>;
  pricePerCall?: string;
  description?: string;
  ownerAgentId?: string;
  timeoutMs?: number;
}): GatewayProvider {
  const db = getDb();
  const providerId = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO gateway_providers
      (provider_id, name, endpoint, method, forward_headers, inject_headers,
       price_per_call, description, owner_agent_id, timeout_ms, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    providerId,
    opts.name,
    opts.endpoint,
    (opts.method ?? "POST").toUpperCase(),
    JSON.stringify(opts.forwardHeaders ?? []),
    encryptInjectHeaders(opts.injectHeaders ?? {}),
    normalizeGatewayPrice(opts.pricePerCall),
    opts.description ?? null,
    opts.ownerAgentId ?? null,
    opts.timeoutMs ?? 30_000,
    createdAt,
  );

  void syncToTurso();
  return getGatewayProvider(providerId)!;
}

export function getGatewayProvider(providerId: string): GatewayProvider | null {
  const row = getDb()
    .prepare("SELECT * FROM gateway_providers WHERE provider_id = ?")
    .get(providerId) as GatewayRow | undefined;
  return row ? rowToProvider(row) : null;
}

export function listGatewayProviders(status?: GatewayProvider["status"]): GatewayProvider[] {
  const db = getDb();
  const rows = status
    ? db.prepare("SELECT * FROM gateway_providers WHERE status = ? ORDER BY created_at DESC").all(status) as GatewayRow[]
    : db.prepare("SELECT * FROM gateway_providers ORDER BY created_at DESC").all() as GatewayRow[];
  return rows.map(rowToProvider);
}

export function deleteGatewayProvider(providerId: string): void {
  const db = getDb();
  // Cancel any tasks that are still queued or running for this provider
  // so they don't stay stuck with no handler to pick them up.
  db.prepare(`
    UPDATE tasks SET status = 'failed', error = ?, completed_at = ?
    WHERE to_agent = ? AND status IN ('queued', 'running')
  `).run("Gateway provider was deleted", new Date().toISOString(), providerId);
  db.prepare("DELETE FROM gateway_providers WHERE provider_id = ?").run(providerId);
  void syncToTurso();
}

export function updateGatewayProviderStatus(
  providerId: string,
  status: GatewayProvider["status"]
): void {
  getDb()
    .prepare("UPDATE gateway_providers SET status = ? WHERE provider_id = ?")
    .run(status, providerId);
  void syncToTurso();
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

export async function proxyToProvider(
  provider: GatewayProvider,
  incomingHeaders: Record<string, string>,
  body: string | undefined
): Promise<GatewayCallResult> {
  // Check circuit breaker before attempting the upstream call
  const circuit = getCircuit(provider.providerId);
  const circuitState = advanceGatewayCircuit(circuit);
  if (circuitState === "open") {
    const retryAfterMs = GATEWAY_RECOVERY_WINDOW_MS - (Date.now() - circuit.openedAt!);
    throw new GatewayCircuitOpenError(provider.providerId, Math.max(0, retryAfterMs));
  }

  // Build upstream headers
  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Axon-Gateway/1.0",
  };

  // Pass through whitelisted headers from the client request
  for (const name of provider.forwardHeaders) {
    const lower = name.toLowerCase();
    if (BLOCKED_UPSTREAM_HEADERS.has(lower)) continue;
    const value = incomingHeaders[lower] ?? incomingHeaders[name];
    if (value) upstreamHeaders[name] = value;
  }

  // Add provider-configured headers (API keys, auth, etc.)
  for (const [k, v] of Object.entries(provider.injectHeaders)) {
    upstreamHeaders[k] = v;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeoutMs);
  const startMs = Date.now();

  let res: Response;
  try {
    res = await publicHttpFetch(provider.endpoint, {
      method: provider.method,
      headers: upstreamHeaders,
      body: provider.method === "GET" || provider.method === "HEAD" ? undefined : body,
      signal: controller.signal,
      maxResponseBytes: 5_000_000,
    });
  } catch (err) {
    recordGatewayFailure(provider.providerId, provider.name);
    recordEndpointCheck(provider.providerId, false);
    throw new Error(
      `Gateway upstream error: ${err instanceof Error ? err.message : "network error"}`
    );
  } finally {
    clearTimeout(timer);
  }

  let responseBody: string;
  try {
    responseBody = await res.text();
  } catch (err) {
    recordGatewayFailure(provider.providerId, provider.name);
    recordEndpointCheck(provider.providerId, false);
    throw new Error(
      `Gateway upstream response error: ${err instanceof Error ? err.message : "body read failed"}`
    );
  }

  // fetch() does not throw on HTTP error status, so a provider that responds but
  // with a 5xx is still a failure for circuit-breaker and uptime purposes —
  // otherwise the breaker never opens for an up-but-broken upstream. The response
  // (including the 5xx body) is still proxied back to the caller below.
  if (res.status >= 500) {
    recordGatewayFailure(provider.providerId, provider.name);
    recordEndpointCheck(provider.providerId, false);
  } else {
    recordGatewaySuccess(provider.providerId);
    recordEndpointCheck(provider.providerId, true);
  }
  const durationMs = Date.now() - startMs;

  // Build a safe set of response headers to return — strip hop-by-hop headers
  const hopByHop = new Set([
    "connection", "keep-alive", "transfer-encoding",
    "te", "trailer", "upgrade", "proxy-authenticate",
    "proxy-authorization", "set-cookie", "set-cookie2",
  ]);
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (!hopByHop.has(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  });

  return { status: res.status, headers: responseHeaders, body: responseBody, durationMs };
}
