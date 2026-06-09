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

// Returns the agent's real system prompt, or a sensible generic fallback
// for agents registered externally (MCP servers, gateway providers, etc.)
export function getAgentSystem(agent: Agent): string {
  return AGENT_SYSTEMS[agent.agentId] ??
    `You are ${agent.name} on the Axon network. ` +
    `Your capabilities include: ${agent.capabilities.join(", ")}. ` +
    `Be specific, actionable, and thorough.`;
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

  async complete(system: string, message: string, maxTokens = 1024): Promise<string> {
    const msg = await this.client.messages.create(
      { model: this.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: message }] },
      { timeout: 120_000 }
    );
    const block = msg.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("No text response from Anthropic");
    return block.text;
  }

  async *stream(system: string, message: string, maxTokens = 2048): AsyncIterable<string> {
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

  async complete(system: string, message: string, maxTokens = 1024): Promise<string> {
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
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Provider ${this.baseUrl} error ${res.status}: ${err}`);
    }

    const data = await res.json() as { choices: { message: { content: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content in provider response");
    return content;
  }

  async *stream(system: string, message: string, maxTokens = 2048): AsyncIterable<string> {
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
  maxTokens = 1024
): Promise<string> {
  return getProvider(agent).complete(getAgentSystem(agent), message, maxTokens);
}
