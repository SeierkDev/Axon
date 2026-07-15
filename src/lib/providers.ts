// Provider-agnostic inference layer.
//
// Agents declare which provider runs their inference via the `provider` field
// in the agents table. The worker and stream endpoint call runWithProvider()
// instead of hardcoding Anthropic — the right client is selected automatically.
//
// Supported providers:
//   anthropic  — Claude via Anthropic API (default)
//   ollama     — Any model via a public Ollama-compatible REST endpoint
//   openai     — GPT models via OpenAI API (same REST shape as Ollama)
//   grok       — Grok models via xAI API (same REST shape as OpenAI)

import Anthropic from "@anthropic-ai/sdk";
import type { Agent } from "@/sdk/types";
import { publicHttpFetch } from "./urlSecurity";
import { logger } from "./logger";
import { recordModelUsage } from "./modelUsage";

// System prompts — imported from each handler so the provider uses the real
// domain-specific prompt, not a generic fallback.
import { SYSTEM as researchSystem }          from "../workers/agents/research";
import { SYSTEM as cryptoSystem }            from "../workers/agents/crypto";
import { SYSTEM as tradingSystem }           from "../workers/agents/trading";
import { SYSTEM as auditSystem }             from "../workers/agents/audit";
import { SYSTEM as defiSystem }              from "../workers/agents/defi";
import { SYSTEM as dataSystem }              from "../workers/agents/data";
import { SYSTEM as contentSystem }           from "../workers/agents/content";
import { SYSTEM as codeSystem }              from "../workers/agents/code";
import { SYSTEM as onchainSystem }           from "../workers/agents/onchain";
import { SYSTEM as strategySystem }          from "../workers/agents/strategy";
import { SYSTEM as seoSystem }               from "../workers/agents/seo";
import { SYSTEM as socialSystem }            from "../workers/agents/social";
import { SYSTEM as emailSystem }             from "../workers/agents/email";
import { SYSTEM as reportSystem }            from "../workers/agents/report";
import { SYSTEM as webSystem }               from "../workers/agents/web";
import { SYSTEM as buildOrchestratorSystem } from "../workers/agents/build-orchestrator";
import { SYSTEM as buildDesignerSystem }     from "../workers/agents/build-designer";
import { SYSTEM as buildWorldSystem }        from "../workers/agents/build-world";
import { SYSTEM as buildCoderSystem }        from "../workers/agents/build-coder";
import { SYSTEM as buildArtistSystem }       from "../workers/agents/build-artist";
import { SYSTEM as buildQaSystem }           from "../workers/agents/build-qa";

// ── Retry utility ─────────────────────────────────────────────────────────────

const TRANSIENT_HTTP_CODES = new Set([429, 500, 503, 529]);

function isTransient(err: unknown): boolean {
  try {
    if (err instanceof Anthropic.RateLimitError) return true;
    if (err instanceof Anthropic.InternalServerError) return true;
    if (err instanceof Anthropic.APIConnectionError) return true;
    if (err instanceof Anthropic.APIConnectionTimeoutError) return true;
    if (err instanceof Anthropic.APIError && TRANSIENT_HTTP_CODES.has(err.status)) return true;
  } catch {
    // Anthropic SDK mocked in tests — fall through to message-based detection
  }
  if (err instanceof Error && (err.name === "AbortError" || /ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message))) return true;
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 1000, label = "provider"): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      console.warn(`[${label}] transient error on attempt ${attempt}/${maxAttempts}, retrying in ${Math.round(delay)}ms`, err instanceof Error ? err.message : err);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────

const AGENT_SYSTEMS: Record<string, string> = {
  "research-agent":       researchSystem,
  "crypto-agent":         cryptoSystem,
  "trading-agent":        tradingSystem,
  "audit-agent":          auditSystem,
  "defi-agent":           defiSystem,
  "data-agent":           dataSystem,
  "content-agent":        contentSystem,
  "code-agent":           codeSystem,
  "onchain-agent":        onchainSystem,
  "strategy-agent":       strategySystem,
  "seo-agent":            seoSystem,
  "social-agent":         socialSystem,
  "email-agent":          emailSystem,
  "report-agent":         reportSystem,
  "web-agent":            webSystem,
  "build-orchestrator":   buildOrchestratorSystem,
  "build-designer":       buildDesignerSystem,
  "build-world":          buildWorldSystem,
  "build-coder":          buildCoderSystem,
  "build-artist":         buildArtistSystem,
  "build-qa":             buildQaSystem,
};

// Appended to every agent system prompt to enforce consistent, expert behavior
// across all Axon agents — platform and community.
const BEHAVIOR_RULES = `

---
Behavior:
- Never open with filler phrases like "Certainly", "Of course", "Sure", "Absolutely", "Great question", or "I'd be happy to help"
- Do not summarise what you are about to do — just do it
- Do not hedge or qualify every statement — be direct and confident in your expertise
- Omit disclaimers about not being a financial, legal, or medical advisor unless the task specifically and genuinely requires one
- Never pad responses with generic closing lines like "Let me know if you need anything else"
- You are a specialist agent deployed on the Axon network — respond with the precision and directness of a domain expert, not a general-purpose assistant`;

// Per-agent token limits — build agents need much higher limits to produce
// complete HTML5 games. All other agents use the default 2048.
// The coder runs on claude-fable-5, whose always-on thinking bills against
// max_tokens — the extra headroom keeps the game itself at ~28k.
const AGENT_MAX_TOKENS: Record<string, number> = {
  "build-orchestrator": 1024,
  "build-designer":     1024,
  "build-world":        2048,
  "build-coder":        40000,
  "build-artist":       28000,
  "build-qa":           1024,
};

export function getAgentMaxTokens(agentId: string): number {
  // 1000-token default (~700 words): interactive-speed deliverables. Length is
  // NOT a truncation risk — the provider auto-continues if a response ever
  // hits the ceiling; agents with bigger real needs are listed above.
  return AGENT_MAX_TOKENS[agentId] ?? 1000;
}

// Returns the agent's real system prompt, or a strong generic fallback
// for community agents registered with their own endpoint.
export function getAgentSystem(agent: Agent): string {
  const core = AGENT_SYSTEMS[agent.agentId] ??
    `You are ${agent.name}, a specialized agent operating on the Axon agent network. ` +
    `Your capabilities: ${agent.capabilities.join(", ")}.\n\n` +
    `Deliver expert-level responses in your domain. Structure every response with clear headers and sections. ` +
    `Be specific — use numbers, examples, and concrete recommendations. ` +
    `Lead with the most important information. ` +
    `Give complete answers, not overviews. ` +
    `Think like the best specialist in your field, not a general assistant.`;

  // Dense beats long, everywhere on the network: tasks settle in seconds, not
  // minutes, and nobody hires an agent twice for a wall of filler.
  return (
    core +
    BEHAVIOR_RULES +
    `\n\nLENGTH: Default to SHORT, dense deliverables — roughly 250-350 words. ` +
    `Only go longer when the task explicitly asks for exhaustive depth. Always end with a clean conclusion.`
  );
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface ProviderClient {
  complete(system: string, message: string, maxTokens?: number, temperature?: number): Promise<string>;
  stream(system: string, message: string, maxTokens?: number): AsyncIterable<string>;
}

// Joins a continuation onto a truncated output. The model may resume a few
// characters before where it stopped, so trim the longest overlap between the
// end of what we have and the start of the continuation before concatenating.
function stitchContinuation(soFar: string, continuation: string): string {
  const maxOverlap = Math.min(soFar.length, continuation.length, 400);
  for (let len = maxOverlap; len > 0; len--) {
    if (soFar.slice(soFar.length - len) === continuation.slice(0, len)) {
      return soFar + continuation.slice(len);
    }
  }
  return soFar + continuation;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

// Where a completion lands if the primary model declines it with a safety
// refusal (Fable-class models only — Opus/Haiku never emit stop_reason "refusal").
const REFUSAL_FALLBACK_MODEL = "claude-opus-4-8";

// Per-provider default models — one source of truth, so getProvider (what runs)
// and effectiveModel (what a reproducibility proof records) can never drift apart.
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const DEFAULT_OLLAMA_MODEL = "llama3.2";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
// xAI's API is OpenAI-compatible. grok-4.5 is the current flagship alias (xAI's
// coding-leading model, live in the EU as of July 2026); env-overridable
// (XAI_MODEL) in case xAI changes the identifier.
const DEFAULT_GROK_MODEL = process.env.XAI_MODEL ?? "grok-4.5";

// True when the API says the model itself can't be used by this org (not a
// transient failure): unknown model or missing entitlement.
function isModelUnavailable(err: unknown): boolean {
  try {
    return (
      err instanceof Anthropic.NotFoundError ||
      err instanceof Anthropic.PermissionDeniedError
    );
  } catch {
    return false; // SDK error classes unavailable (mocked module)
  }
}

class AnthropicProvider implements ProviderClient {
  private client: Anthropic;
  private model: string;

  constructor(model?: string) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.client = new Anthropic({ apiKey });
    // Sonnet 5 default: current knowledge (Haiku 4.5's early-2025 cutoff
    // predated x402 and dead-ended research tasks) at interactive speed — a
    // 3-step pipeline on Opus took minutes, which kills the showcase.
    this.model = model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  // 4096: Opus-tier agents write full deliverables — 2048 truncated pipeline
  // outputs mid-sentence.
  async complete(system: string, message: string, maxTokens = 4096, temperature?: number): Promise<string> {
    let first: { text: string; refused: boolean };
    try {
      first = await this.completeWith(this.model, system, message, maxTokens, temperature);
    } catch (err) {
      // The org may not have access to the primary model at all (404/403, e.g.
      // a Fable-class model without the required retention setting). A paid
      // build must never die on that — re-run on the Opus fallback.
      if (this.model !== REFUSAL_FALLBACK_MODEL && isModelUnavailable(err)) {
        logger.warn("provider.model_fallback", "Primary model unavailable — falling back", {
          model: this.model,
          fallback: REFUSAL_FALLBACK_MODEL,
          reason: err instanceof Error ? err.message : String(err),
        });
        const rescued = await this.completeWith(REFUSAL_FALLBACK_MODEL, system, message, maxTokens, temperature);
        if (rescued.refused) throw new Error("Model declined the request (fallback included)");
        return rescued.text;
      }
      throw err;
    }
    if (!first.refused) return first.text;
    // Fable-class models can decline a request outright (stop_reason "refusal",
    // occasionally a false positive on benign work) — same fallback.
    if (this.model === REFUSAL_FALLBACK_MODEL) {
      throw new Error(`Model ${this.model} declined the request`);
    }
    logger.warn("provider.model_fallback", "Primary model refused — falling back", {
      model: this.model,
      fallback: REFUSAL_FALLBACK_MODEL,
      reason: "refusal",
    });
    const second = await this.completeWith(REFUSAL_FALLBACK_MODEL, system, message, maxTokens, temperature);
    if (second.refused) throw new Error("Model declined the request (fallback included)");
    return second.text;
  }

  private async completeWith(
    model: string,
    system: string,
    message: string,
    maxTokens: number,
    temperature?: number,
  ): Promise<{ text: string; refused: boolean }> {
    const timeoutMs = Math.max(120_000, maxTokens * 30);
    // If the model hits the token ceiling mid-output, ask it to continue from
    // where it stopped — as a normal follow-up turn, since this model doesn't
    // allow assistant prefill (the conversation must end with a user message).
    // Stitch the pieces (trimming any repeated boundary overlap) so a long file
    // completes across chunks instead of failing. The ceiling is a chunk size.
    const MAX_CONTINUATIONS = 5;
    let full = "";
    for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
      const messages: Anthropic.MessageParam[] =
        round === 0
          ? [{ role: "user", content: message }]
          : [
              { role: "user", content: message },
              { role: "assistant", content: full },
              {
                role: "user",
                content:
                  "Your previous response was cut off because it was too long. Continue from EXACTLY where it stopped and output ONLY the remaining content — do not repeat anything you already wrote, do not restate the file, and do not add any explanation or markdown fences.",
              },
            ];
      // NOTE: `temperature` is intentionally NOT forwarded — current Claude models
      // (Sonnet 5 / 4.6+ era) reject the parameter as deprecated (API 400). The
      // param stays in the signature for the ProviderClient interface; callers
      // needing determinism (reproducibility) rely on the pinned model + frozen
      // input and must record that no temperature was applied.
      void temperature;
      const msg = await withRetry(
        () =>
          this.client.messages
            .stream({ model, max_tokens: maxTokens, system, messages }, { timeout: timeoutMs })
            .finalMessage(),
        3,
        1000,
        `anthropic:${model}`,
      );
      // Report token usage into the active trace step (no-op when untraced),
      // accumulating across continuation rounds. Best-effort — never let it
      // disturb the model call.
      try {
        if (msg.usage) recordModelUsage(model, msg.usage.input_tokens ?? 0, msg.usage.output_tokens ?? 0);
      } catch {
        /* usage capture is optional */
      }
      // A safety refusal may arrive before any output (empty content) or
      // mid-stream (partial output) — discard partials, the caller falls back.
      if ((msg.stop_reason as string) === "refusal") return { text: "", refused: true };
      const block = msg.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") throw new Error("No text response from Anthropic");
      full = round === 0 ? block.text : stitchContinuation(full, block.text);
      if (msg.stop_reason !== "max_tokens") return { text: full, refused: false }; // finished cleanly
    }
    // Continuation cap reached — return the best effort rather than failing the build.
    return { text: full, refused: false };
  }

  async *stream(system: string, message: string, maxTokens = 4096): AsyncIterable<string> {
    const s = this.client.messages.stream(
      { model: this.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: message }] },
      { timeout: 180_000 }
    );
    for await (const event of s) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  }
}

// ── OpenAI-compatible (Ollama + OpenAI share the same REST shape) ─────────────

class OpenAICompatibleProvider implements ProviderClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  // 4096: Opus-tier agents write full deliverables — 2048 truncated pipeline
  // outputs mid-sentence.
  async complete(system: string, message: string, maxTokens = 4096, temperature?: number): Promise<string> {
    return withRetry(async () => {
      const res = await publicHttpFetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          ...(temperature !== undefined ? { temperature } : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: message },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
        maxResponseBytes: 5_000_000,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        const err = new Error(`Provider ${this.baseUrl} error ${res.status}: ${errText}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }

      const data = await res.json() as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("No content in provider response");
      try {
        if (data.usage) recordModelUsage(this.model, data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0);
      } catch {
        /* usage capture is optional */
      }
      return content;
    }, 3, 1000, `openai-compat:${this.model}`);
  }

  async *stream(system: string, message: string, maxTokens = 4096): AsyncIterable<string> {
    const res = await publicHttpFetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: message },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
      maxResponseBytes: 5_000_000,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Provider ${this.baseUrl} error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data) as { choices: { delta: { content?: string } }[] };
            const chunk = parsed.choices?.[0]?.delta?.content;
            if (chunk) yield chunk;
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      const finalLine = buffer.trimEnd();
      if (finalLine.startsWith("data: ")) {
        const data = finalLine.slice(6).trim();
        if (data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data) as { choices: { delta: { content?: string } }[] };
            const chunk = parsed.choices?.[0]?.delta?.content;
            if (chunk) yield chunk;
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export function getProvider(agent: Agent): ProviderClient {
  const { provider, providerModel, providerEndpoint } = agent;

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(providerModel);

    case "ollama": {
      if (!providerEndpoint) {
        throw new Error("providerEndpoint is required for ollama agents and must be a public HTTP(S) endpoint");
      }
      const base = providerEndpoint.replace(/\/$/, "");
      const model = providerModel ?? DEFAULT_OLLAMA_MODEL;
      return new OpenAICompatibleProvider(`${base}/v1`, "", model);
    }

    case "openai": {
      if (providerEndpoint) {
        throw new Error("Custom providerEndpoint is not supported for openai agents");
      }
      const apiKey = process.env.OPENAI_API_KEY ?? "";
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      const base = "https://api.openai.com/v1";
      const model = providerModel ?? DEFAULT_OPENAI_MODEL;
      return new OpenAICompatibleProvider(base, apiKey, model);
    }

    case "grok": {
      // xAI (Grok) — OpenAI-compatible REST at api.x.ai, server-side XAI_API_KEY.
      if (providerEndpoint) {
        throw new Error("Custom providerEndpoint is not supported for grok agents");
      }
      const apiKey = process.env.XAI_API_KEY ?? "";
      if (!apiKey) throw new Error("XAI_API_KEY is not set");
      const base = "https://api.x.ai/v1";
      const model = providerModel ?? DEFAULT_GROK_MODEL;
      return new OpenAICompatibleProvider(base, apiKey, model);
    }

    default:
      throw new Error(`Unknown inference provider: "${provider}"`);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Called by the worker and stream endpoint instead of hardcoding Anthropic.

export async function runWithProvider(
  agent: Agent,
  message: string,
  maxTokens = 2048
): Promise<string> {
  return getProvider(agent).complete(getAgentSystem(agent), message, maxTokens);
}

// The model that WOULD run for this agent, resolving defaults the same way the
// providers do — so a reproducibility proof can record the concrete model it ran,
// never a misleading null. `pinned` (the model read from the original trace) wins.
export function effectiveModel(agent: Agent, pinned?: string | null): string | null {
  if (pinned) return pinned;
  if (agent.providerModel) return agent.providerModel;
  // No pinned/configured model — resolve the same default the provider would use,
  // so the proof records the concrete model that actually ran, never null.
  switch (agent.provider) {
    case "ollama":
      return DEFAULT_OLLAMA_MODEL;
    case "openai":
      return DEFAULT_OPENAI_MODEL;
    case "grok":
      return DEFAULT_GROK_MODEL;
    case "anthropic":
      return DEFAULT_ANTHROPIC_MODEL;
    default:
      return null;
  }
}

// A deterministic re-run for reproducibility proofs: pins the exact model that
// originally ran (so a post-refusal fallback is reproduced faithfully) and drives
// temperature 0. Everything else — system prompt, token ceiling, continuation
// stitching — matches a normal run. See src/lib/reproducibility.ts.
export async function runReproduction(
  agent: Agent,
  message: string,
  maxTokens: number,
  opts: { model?: string; temperature?: number } = {},
): Promise<string> {
  const model = opts.model ?? agent.providerModel;
  // Pin the model for every provider — not just Anthropic — so the re-run uses the
  // same model the proof claims, even for openai/ollama agents.
  const provider =
    agent.provider === "anthropic" ? new AnthropicProvider(model) : getProvider({ ...agent, providerModel: model });
  return provider.complete(getAgentSystem(agent), message, maxTokens, opts.temperature);
}
