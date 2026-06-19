import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { decodeRequirements } from "./x402";
import { publicHttpFetch } from "./urlSecurity";
import { logger } from "./logger";

export type VerificationStatus = "unverified" | "reachable" | "x402_compliant" | "unreachable";

export interface VerificationResult {
  agentId: string;
  status: VerificationStatus;
  latencyMs: number | null;
  checkedAt: string;
  detail: string;
}

// Probes an agent's registered endpoint and checks x402 compliance.
// Levels:
//   unreachable    — couldn't connect or returned an error at both GET and POST
//   reachable      — responds to GET or POST with a parseable response (no x402)
//   x402_compliant — returns 402 with a valid X-Payment-Required header
//
// After the reachability check, a functional POST probe is sent with a standardised
// health-check payload. The agent is still marked reachable if the POST fails, but
// the detail message records the outcome so operators can investigate.
export async function verifyAgentEndpoint(
  agentId: string,
  endpoint: string
): Promise<VerificationResult> {
  const checkedAt = new Date().toISOString();
  let status: VerificationStatus = "unreachable";
  let latencyMs: number | null = null;
  let detail = "";

  try {
    // ── Step 1: reachability GET ─────────────────────────────────────────────
    const start = Date.now();
    const res = await publicHttpFetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
      maxResponseBytes: 64_000,
    });
    latencyMs = Date.now() - start;

    if (res.status === 402) {
      const raw = res.headers.get("x-payment-required");
      if (raw) {
        const requirements = decodeRequirements(raw);
        if (requirements) {
          status = "x402_compliant";
          detail = `402 with valid X-Payment-Required — ${requirements.accepts[0]?.asset ?? "unknown"} on ${requirements.accepts[0]?.network ?? "unknown"}`;
        } else {
          status = "reachable";
          detail = "402 returned but X-Payment-Required header could not be decoded";
        }
      } else {
        status = "reachable";
        detail = "402 returned but X-Payment-Required header is missing";
      }
    } else if (res.status >= 200 && res.status < 500) {
      status = "reachable";
      detail = `HTTP ${res.status} — endpoint is up`;
    } else {
      status = "unreachable";
      detail = `HTTP ${res.status} — server error on GET`;
    }

    // ── Step 2: functional POST probe (only if reachable, not x402) ─────────
    // Sends a standard health-check task and validates the response shape.
    // A failed probe does not downgrade the status — it adds context to detail.
    if (status === "reachable") {
      try {
        const probeBody = JSON.stringify({
          taskId: `axon-probe-${Date.now()}`,
          task: "health-check",
          context: {},
        });
        const postStart = Date.now();
        const postRes = await publicHttpFetch(endpoint, {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: probeBody,
          maxResponseBytes: 64_000,
        });
        const postLatency = Date.now() - postStart;

        if (postRes.status >= 200 && postRes.status < 300) {
          const text = await postRes.text().catch(() => "");
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { parsed = null; }

          if (
            parsed !== null &&
            typeof parsed === "object" &&
            ("output" in (parsed as object) || "result" in (parsed as object) || "response" in (parsed as object))
          ) {
            detail += ` | POST probe OK (${postLatency}ms) — valid response schema`;
          } else if (parsed !== null) {
            detail += ` | POST probe OK (${postLatency}ms) — JSON returned but missing output/result/response field`;
          } else {
            detail += ` | POST probe returned non-JSON body`;
          }
        } else if (postRes.status === 405) {
          // Agent doesn't accept POST — still reachable via GET, just not task-capable
          detail += ` | POST not accepted (405) — agent may be GET-only`;
        } else {
          detail += ` | POST probe returned HTTP ${postRes.status}`;
        }
      } catch (postErr) {
        detail += ` | POST probe failed: ${postErr instanceof Error ? postErr.message : "unknown error"}`;
      }
    }
  } catch (err) {
    status = "unreachable";
    detail = err instanceof Error ? err.message : "Connection failed";
    latencyMs = null;
  }

  // Persist result to agents table
  getDb().prepare(`
    UPDATE agents
    SET verification_status = ?, last_verified_at = ?
    WHERE agent_id = ?
  `).run(status, checkedAt, agentId);
  void syncToTurso();

  const logFields = { agentId, status, latencyMs, detail };
  if (status === "unreachable") {
    logger.warn("agent.verification_checked", "Agent verification failed", logFields);
  } else {
    logger.info("agent.verification_checked", "Agent verification checked", logFields);
  }

  return { agentId, status, latencyMs, checkedAt, detail };
}
