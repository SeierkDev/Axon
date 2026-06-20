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

import Anthropic from "@anthropic-ai/sdk";
import type { Agent } from "@/sdk/types";
import { publicHttpFetch } from "./urlSecurity";

// System prompts — imported from each handler so the provider uses the real
// domain-specific prompt, not a generic fallback.
import { SYSTEM as researchSystem }  from "../workers/agents/research";
import { SYSTEM as cryptoSystem }    from "../workers/agents/crypto";
import { SYSTEM as tradingSystem }   from "../workers/agents/trading";
import { SYSTEM as auditSystem }     from "../workers/agents/audit";
import { SYSTEM as defiSystem }      from "../workers/agents/defi";
import { SYSTEM as dataSystem }      from "../workers/agents/data";
import { SYSTEM as contentSystem }   from "../workers/agents/content";
import { SYSTEM as codeSystem }      from "../workers/agents/code";
import { SYSTEM as onchainSystem }   from "../workers/agents/onchain";
import { SYSTEM as strategySystem }  from "../workers/agents/strategy";
import { SYSTEM as seoSystem }       from "../workers/agents/seo";
import { SYSTEM as socialSystem }    from "../workers/agents/social";
import { SYSTEM as emailSystem }     from "../workers/agents/email";
import { SYSTEM as reportSystem }    from "../workers/agents/report";
import { SYSTEM as webSystem }       from "../workers/agents/web";

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

export function getAgentMaxTokens(_agentId: string): number {
  return 2048;
}

const AGENT_SYSTEMS: Record<string, string> = {
  "research-agent":  researchSystem,
  "crypto-agent":    cryptoSystem,
  "trading-agent":   tradingSystem,
  "audit-agent":     auditSystem,
  "defi-agent":      defiSystem,
  "data-agent":      dataSystem,
  "content-agent":   contentSystem,
  "code-agent":      codeSystem,
  "onchain-agent":   onchainSystem,
  "strategy-agent":  strategySystem,
  "seo-agent":       seoSystem,
  "social-agent":    socialSystem,
  "email-agent":     emailSystem,
  "report-agent":    reportSystem,
  "web-agent":       webSystem,
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

  return core + BEHAVIOR_RULES;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface ProviderClient {
  complete(system: string, message: string, maxTokens?: number): Promise<string>;
  stream(system: string, message: string, maxTokens?: number): AsyncIterable<string>;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

class AnthropicProvider implements ProviderClient {
  private client: Anthropic;
  private model: string;

  constructor(model?: string) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.client = new Anthropic({ apiKey });
    this.model = model ?? "claude-haiku-4-5-20251001";
  }

  async complete(system: string, message: string, maxTokens = 2048): Promise<string> {
    const timeoutMs = Math.max(120_000, maxTokens * 30);
    return withRetry(() => this.client.messages.create(
      { model: this.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: message }] },
      { timeout: timeoutMs }
    ).then((msg) => {
      const block = msg.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") throw new Error("No text response from Anthropic");
      return block.text;
    }), 3, 1000, `anthropic:${this.model}`);
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

  async complete(system: string, message: string, maxTokens = 2048): Promise<string> {
    return withRetry(async () => {
      const res = await publicHttpFetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
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
        throw new Error(`Provider ${this.baseUrl} error ${res.status}: ${errText}`);
      }

      const data = await res.json() as { choices: { message: { content: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("No content in provider response");
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
      const model = providerModel ?? "llama3.2";
      return new OpenAICompatibleProvider(`${base}/v1`, "", model);
    }

    case "openai": {
      if (providerEndpoint) {
        throw new Error("Custom providerEndpoint is not supported for openai agents");
      }
      const apiKey = process.env.OPENAI_API_KEY ?? "";
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      const base = "https://api.openai.com/v1";
      const model = providerModel ?? "gpt-4o-mini";
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
