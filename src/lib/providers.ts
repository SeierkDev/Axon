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
// Type-only: the tool layer builds the definitions and closures, this module
// only runs them. Keeps the DB off the model-call path at runtime.
import type { ResolvedTools, LocalTool } from "./agentTools";
import { MAX_TOOL_STEPS, MAX_TOOL_RESULT_CHARS } from "./agentToolLimits";

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

// One tool invocation, reported the moment it finishes so the caller can put it
// in the receipt's flight recorder. Raw args and result are handed over so the
// caller can hash them — nothing content-bearing is ever stored by the trace.
export interface ToolCallEvent {
  /** Readable name for the receipt: "web_search", or "<server>/<tool>" for MCP. */
  tool: string;
  kind: "web_search" | "web_fetch" | "mcp";
  ok: boolean;
  /** null for server-side tools, which run inside the model call and aren't timed separately. */
  latencyMs: number | null;
  input: string;
  output: string;
  error?: string;
}

export type ToolCallSink = (event: ToolCallEvent) => void;

export interface ToolRunOptions {
  /** Called as each tool finishes, so the caller can record it in the trace. */
  onToolCall?: ToolCallSink;
  /**
   * Stops the loop between rounds. A tool loop is many model calls, so a caller
   * whose client has gone away (a disconnected SSE stream) needs a way to stop
   * paying for the rest of it.
   */
  signal?: AbortSignal;
}

export interface ProviderClient {
  complete(system: string, message: string, maxTokens?: number, temperature?: number): Promise<string>;
  stream(system: string, message: string, maxTokens?: number): AsyncIterable<string>;
  /**
   * Run the completion as a bounded tool loop: the model may search, fetch, and
   * call MCP tools before it answers. Optional — providers without tool support
   * omit it and the caller falls back to a plain single call.
   */
  completeWithTools?(
    system: string,
    message: string,
    maxTokens: number,
    tools: ResolvedTools,
    opts?: ToolRunOptions,
  ): Promise<string>;
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
// The API rejected the request shape itself (400) — not a transient failure and
// not something a retry fixes.
function isBadRequest(err: unknown): boolean {
  try {
    return err instanceof Anthropic.BadRequestError;
  } catch {
    return false; // SDK error classes unavailable (mocked module)
  }
}

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

// ── Tool-loop helpers ─────────────────────────────────────────────────────────

// A loop that spent every round on tools and never wrote an answer has produced
// nothing to deliver. Fail loudly — the task then fails and refunds, which is the
// honest outcome. Silently completing with "" would settle payment for no work.
function requireText(text: string): string {
  if (!text.trim()) throw new Error("No text response from Anthropic (tool loop produced no answer)");
  return text;
}

// Server-side tools (web search / fetch) run inside the model call, so they show
// up as matched server_tool_use → *_tool_result pairs in the response rather than
// as something we execute. Pair them up and report each one.
function reportServerToolCalls(content: Anthropic.ContentBlock[], sink?: ToolCallSink): void {
  if (!sink) return;
  const uses = new Map<string, { name: string; input: unknown }>();
  for (const block of content) {
    if (block.type === "server_tool_use") uses.set(block.id, { name: block.name, input: block.input });
  }
  for (const block of content) {
    if (block.type !== "web_search_tool_result" && block.type !== "web_fetch_tool_result") continue;
    const use = uses.get(block.tool_use_id);
    const kind = block.type === "web_search_tool_result" ? "web_search" : "web_fetch";
    // A failed server tool returns a single error object where a success returns
    // results; that shape difference is the only signal available here.
    const payload = block.content as unknown;
    const errorCode =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { error_code?: string }).error_code
        : undefined;
    sink({
      tool: use?.name ?? kind,
      kind,
      ok: !errorCode,
      latencyMs: null,
      input: JSON.stringify(use?.input ?? {}),
      output: errorCode ? "" : JSON.stringify(payload ?? null),
      ...(errorCode ? { error: errorCode } : {}),
    });
  }
}

// Execute one model-requested local (MCP) tool call and shape the result block.
// A tool that throws comes back as an is_error result rather than a thrown
// exception: the model can read the message and try something else, which is a
// far better outcome for a paid task than failing the whole job.
async function runLocalTool(
  use: Anthropic.ToolUseBlock,
  byName: Map<string, LocalTool>,
  sink?: ToolCallSink,
): Promise<Anthropic.ToolResultBlockParam> {
  const tool = byName.get(use.name);
  const args = (use.input ?? {}) as Record<string, unknown>;
  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: `Unknown tool '${use.name}'. Use only the tools provided.`,
      is_error: true,
    };
  }

  const startedAt = Date.now();
  try {
    const raw = await tool.run(args);
    const output =
      raw.length > MAX_TOOL_RESULT_CHARS ? `${raw.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated]` : raw;
    sink?.({
      tool: tool.label,
      kind: "mcp",
      ok: true,
      latencyMs: Date.now() - startedAt,
      input: JSON.stringify(args),
      output,
    });
    return { type: "tool_result", tool_use_id: use.id, content: output || "(no output)" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "tool call failed";
    sink?.({
      tool: tool.label,
      kind: "mcp",
      ok: false,
      latencyMs: Date.now() - startedAt,
      input: JSON.stringify(args),
      output: "",
      error: msg,
    });
    return { type: "tool_result", tool_use_id: use.id, content: `Error: ${msg}`, is_error: true };
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
    return this.withModelFallback((model) => this.completeWith(model, system, message, maxTokens, temperature));
  }

  // Runs `attempt` on the configured model and, if that model is unavailable to
  // this org (404/403) or declines the request outright (stop_reason "refusal",
  // occasionally a false positive on benign work), re-runs it on the Opus
  // fallback. A paid task must never die on either.
  private async withModelFallback(
    attempt: (model: string) => Promise<{ text: string; refused: boolean }>,
  ): Promise<string> {
    let first: { text: string; refused: boolean };
    try {
      first = await attempt(this.model);
    } catch (err) {
      if (this.model !== REFUSAL_FALLBACK_MODEL && isModelUnavailable(err)) {
        logger.warn("provider.model_fallback", "Primary model unavailable — falling back", {
          model: this.model,
          fallback: REFUSAL_FALLBACK_MODEL,
          reason: err instanceof Error ? err.message : String(err),
        });
        const rescued = await attempt(REFUSAL_FALLBACK_MODEL);
        if (rescued.refused) throw new Error("Model declined the request (fallback included)");
        return rescued.text;
      }
      throw err;
    }
    if (!first.refused) return first.text;
    if (this.model === REFUSAL_FALLBACK_MODEL) {
      throw new Error(`Model ${this.model} declined the request`);
    }
    logger.warn("provider.model_fallback", "Primary model refused — falling back", {
      model: this.model,
      fallback: REFUSAL_FALLBACK_MODEL,
      reason: "refusal",
    });
    const second = await attempt(REFUSAL_FALLBACK_MODEL);
    if (second.refused) throw new Error("Model declined the request (fallback included)");
    return second.text;
  }

  // ── Tool loop ───────────────────────────────────────────────────────────────
  // The agent gets to look things up before it answers: the model may call web
  // search, web fetch, and any granted MCP tool, and we feed each result back
  // until it stops asking. Bounded by MAX_TOOL_STEPS, then forced to answer.

  async completeWithTools(
    system: string,
    message: string,
    maxTokens: number,
    tools: ResolvedTools,
    opts: ToolRunOptions = {},
  ): Promise<string> {
    return this.withModelFallback((model) => this.toolLoop(model, system, message, maxTokens, tools, opts));
  }

  private async toolLoop(
    model: string,
    system: string,
    message: string,
    maxTokens: number,
    tools: ResolvedTools,
    { onToolCall, signal }: ToolRunOptions,
  ): Promise<{ text: string; refused: boolean }> {
    const timeoutMs = Math.max(120_000, maxTokens * 30);
    const byName = new Map<string, LocalTool>(tools.localTools.map((t) => [t.name, t]));
    const toolDefs: Anthropic.Messages.ToolUnion[] = [
      ...tools.serverTools,
      ...tools.localTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
      })),
    ];

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: message }];
    let lastText = "";

    // One extra pass past the cap, with tools switched off, so a loop that runs
    // long still ends with a real deliverable instead of a dangling tool call.
    for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
      // Checked before every model call, so an abandoned request stops costing
      // money at the next round boundary rather than running the loop out.
      if (signal?.aborted) throw new Error("Tool loop aborted");
      const exhausted = step === MAX_TOOL_STEPS;
      const msg = await withRetry(
        () =>
          this.client.messages
            .stream(
              {
                model,
                max_tokens: maxTokens,
                system,
                messages,
                tools: toolDefs,
                ...(exhausted ? { tool_choice: { type: "none" as const } } : {}),
              },
              { timeout: timeoutMs },
            )
            .finalMessage(),
        3,
        1000,
        `anthropic-tools:${model}`,
      );

      try {
        if (msg.usage) recordModelUsage(model, msg.usage.input_tokens ?? 0, msg.usage.output_tokens ?? 0);
      } catch {
        /* usage capture is optional */
      }

      if ((msg.stop_reason as string) === "refusal") return { text: "", refused: true };

      reportServerToolCalls(msg.content, onToolCall);

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) lastText = text;

      // A long server-tool run pauses the turn; resume by replaying it back with
      // no new user message. Costs a step, which is the point of the cap.
      if ((msg.stop_reason as string) === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });
        continue;
      }

      const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) return { text: requireText(lastText), refused: false };

      // Truncation can cut a tool call off mid-arguments. Running it would call
      // the tool with the wrong input, so stop here and deliver what we have.
      if ((msg.stop_reason as string) === "max_tokens") return { text: requireText(lastText), refused: false };

      messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });
      // Parallel tool calls arrive in one message and all results must go back in
      // one user message — splitting them teaches the model to stop parallelising.
      const results = await Promise.all(toolUses.map((use) => runLocalTool(use, byName, onToolCall)));
      messages.push({ role: "user", content: results });
    }

    return { text: requireText(lastText), refused: false };
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
  maxTokens = 2048,
  // Optional model override for anthropic agents — lets the network-activity cron run
  // on a cheaper model to keep spend low while staying fully real (measured tokens, real
  // output, reproducible). Real hires pass no override and keep the agent's configured
  // model. Ignored for non-anthropic providers (e.g. grok).
  modelOverride?: string,
): Promise<string> {
  const client =
    modelOverride && agent.provider === "anthropic"
      ? getProvider({ ...agent, providerModel: modelOverride })
      : getProvider(agent);
  return client.complete(getAgentSystem(agent), message, maxTokens);
}

// Same as runWithProvider, but the agent gets to use its granted tools first:
// search the live web, fetch a page, call an MCP tool, then answer. Providers
// without tool support fall back to a single call, so a grant on (say) an Ollama
// agent degrades to today's behaviour instead of failing the task.
export async function runWithProviderTools(
  agent: Agent,
  message: string,
  maxTokens: number,
  tools: ResolvedTools,
  opts: ToolRunOptions = {},
): Promise<string> {
  const client = getProvider(agent);
  const system = getAgentSystem(agent);
  if (!client.completeWithTools) {
    logger.warn("provider.tools_unsupported", "Provider has no tool support — running without tools", {
      agentId: agent.agentId,
      provider: agent.provider,
      grants: tools.grants,
    });
    return client.complete(system, message, maxTokens);
  }
  try {
    return await client.completeWithTools(system, message, maxTokens, tools, opts);
  } catch (err) {
    // The request itself was rejected — an agent pinned to a model that doesn't
    // offer server tools, or an MCP server publishing a schema the API won't
    // accept. Answer the job without tools rather than failing a paid task over
    // a misconfiguration; the receipt records only the calls that really ran.
    if (isBadRequest(err)) {
      logger.warn("provider.tools_rejected", "Tool request rejected — answering without tools", {
        agentId: agent.agentId,
        model: agent.providerModel ?? null,
        grants: tools.grants,
        reason: err instanceof Error ? err.message : String(err),
      });
      return client.complete(system, message, maxTokens);
    }
    throw err;
  }
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
