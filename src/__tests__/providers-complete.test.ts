// Tests for providers.ts — complete(), stream(), and runWithProvider().
// AnthropicProvider is tested via a vi.mock of "@anthropic-ai/sdk" using a class stub.
// OpenAICompatibleProvider is tested via a vi.mock of "@/lib/urlSecurity" (publicHttpFetch).
// Kept separate from providers.test.ts so mocks are isolated (vitest isolate:true).

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Hoist mock functions so they are available inside vi.mock factories (hoisted at compile time).
const { mockCreate, mockStream, mockPublicHttpFetch } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockStream: vi.fn(),
  mockPublicHttpFetch: vi.fn(),
}));

// Mock the Anthropic SDK with a class stub that exposes our vi.fn handles.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate, stream: mockStream };
    constructor() {}
  },
}));

vi.mock("@/lib/urlSecurity", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/urlSecurity")>();
  return { ...original, publicHttpFetch: mockPublicHttpFetch };
});

import type { Agent } from "@/sdk/types";
import { getProvider, runWithProvider } from "@/lib/providers";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-mock";
  process.env.OPENAI_API_KEY = "openai-test-key";
});

afterEach(() => {
  mockCreate.mockReset();
  mockStream.mockReset();
  mockPublicHttpFetch.mockReset();
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: "research-agent",
    name: "Research Agent",
    capabilities: ["research"],
    publicKey: "pk-test",
    walletAddress: "11111111111111111111111111111111",
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── AnthropicProvider.complete() ──────────────────────────────────────────────

describe("AnthropicProvider.complete: happy path", () => {
  it("returns the text block from the API response", async () => {
    mockStream.mockReturnValueOnce({
      finalMessage: () => Promise.resolve({ content: [{ type: "text", text: "Hello from Claude" }] }),
    });
    const provider = getProvider(makeAgent({ provider: "anthropic" }));
    expect(await provider.complete("system", "hello")).toBe("Hello from Claude");
  });
});

describe("AnthropicProvider.complete: continues past max_tokens truncation", () => {
  it("stitches chunks until the model stops cleanly", async () => {
    mockStream
      .mockReturnValueOnce({
        finalMessage: () => Promise.resolve({ content: [{ type: "text", text: "<html>chunk1" }], stop_reason: "max_tokens" }),
      })
      .mockReturnValueOnce({
        finalMessage: () => Promise.resolve({ content: [{ type: "text", text: "chunk2</html>" }], stop_reason: "end_turn" }),
      });
    const provider = getProvider(makeAgent({ provider: "anthropic" }));
    expect(await provider.complete("system", "message")).toBe("<html>chunk1chunk2</html>");
  });
});

describe("AnthropicProvider.complete: no text block in response", () => {
  it("throws when response has only a tool_use block", async () => {
    mockStream.mockReturnValueOnce({
      finalMessage: () => Promise.resolve({ content: [{ type: "tool_use", id: "tu_1", name: "search", input: {} }] }),
    });
    const provider = getProvider(makeAgent({ provider: "anthropic" }));
    await expect(provider.complete("system", "message")).rejects.toThrow(/No text response/);
  });

  it("throws when response content array is empty", async () => {
    mockStream.mockReturnValueOnce({ finalMessage: () => Promise.resolve({ content: [] }) });
    const provider = getProvider(makeAgent({ provider: "anthropic" }));
    await expect(provider.complete("system", "message")).rejects.toThrow(/No text response/);
  });
});

describe("AnthropicProvider.complete: refusal falls back to Opus", () => {
  it("re-runs a refused completion on the fallback model and returns its text", async () => {
    mockStream
      .mockReturnValueOnce({
        finalMessage: () => Promise.resolve({ content: [], stop_reason: "refusal" }),
      })
      .mockReturnValueOnce({
        finalMessage: () => Promise.resolve({ content: [{ type: "text", text: "Rescued output" }], stop_reason: "end_turn" }),
      });
    const provider = getProvider(makeAgent({ provider: "anthropic", providerModel: "claude-fable-5" }));
    expect(await provider.complete("system", "message")).toBe("Rescued output");
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockStream.mock.calls[0][0].model).toBe("claude-fable-5");
    expect(mockStream.mock.calls[1][0].model).toBe("claude-opus-4-8");
  });

  it("discards partial output from a mid-stream refusal", async () => {
    mockStream
      .mockReturnValueOnce({
        finalMessage: () => Promise.resolve({ content: [{ type: "text", text: "partial garbage" }], stop_reason: "refusal" }),
      })
      .mockReturnValueOnce({
        finalMessage: () => Promise.resolve({ content: [{ type: "text", text: "Clean output" }], stop_reason: "end_turn" }),
      });
    const provider = getProvider(makeAgent({ provider: "anthropic", providerModel: "claude-fable-5" }));
    expect(await provider.complete("system", "message")).toBe("Clean output");
  });

  it("throws when the fallback model refuses too", async () => {
    mockStream
      .mockReturnValueOnce({ finalMessage: () => Promise.resolve({ content: [], stop_reason: "refusal" }) })
      .mockReturnValueOnce({ finalMessage: () => Promise.resolve({ content: [], stop_reason: "refusal" }) });
    const provider = getProvider(makeAgent({ provider: "anthropic", providerModel: "claude-fable-5" }));
    await expect(provider.complete("system", "message")).rejects.toThrow(/declined/);
  });

  it("throws without a second call when the primary IS the fallback model", async () => {
    mockStream.mockReturnValueOnce({
      finalMessage: () => Promise.resolve({ content: [], stop_reason: "refusal" }),
    });
    const provider = getProvider(makeAgent({ provider: "anthropic", providerModel: "claude-opus-4-8" }));
    await expect(provider.complete("system", "message")).rejects.toThrow(/declined/);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});

describe("AnthropicProvider.complete: API error propagates", () => {
  it("rethrows errors from the Anthropic API", async () => {
    mockStream.mockReturnValueOnce({ finalMessage: () => Promise.reject(new Error("Rate limit exceeded")) });
    const provider = getProvider(makeAgent({ provider: "anthropic" }));
    await expect(provider.complete("system", "message")).rejects.toThrow(/Rate limit/);
  });
});

// ── AnthropicProvider.stream() ────────────────────────────────────────────────

describe("AnthropicProvider.stream: yields text_delta events and skips others", () => {
  it("collects only text_delta events from the async stream", async () => {
    async function* fakeStream() {
      yield { type: "message_start", message: {} };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } };
      yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "world" } };
      yield { type: "message_stop" };
    }
    mockStream.mockReturnValueOnce(fakeStream());

    const provider = getProvider(makeAgent({ provider: "anthropic" }));
    const chunks: string[] = [];
    for await (const chunk of provider.stream("system", "message")) chunks.push(chunk);
    expect(chunks).toEqual(["Hello ", "world"]);
  });
});

// ── runWithProvider ───────────────────────────────────────────────────────────

describe("runWithProvider: delegates to provider.complete", () => {
  it("returns the provider output for an anthropic agent", async () => {
    mockStream.mockReturnValueOnce({
      finalMessage: () => Promise.resolve({ content: [{ type: "text", text: "Research result" }] }),
    });
    const result = await runWithProvider(
      makeAgent({ provider: "anthropic", agentId: "research-agent" }),
      "Summarize this"
    );
    expect(result).toBe("Research result");
  });
});

// ── OpenAICompatibleProvider.complete() ──────────────────────────────────────

describe("OpenAICompatibleProvider.complete: happy path (ollama)", () => {
  it("returns content from the first choice", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Ollama response" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const provider = getProvider(
      makeAgent({ provider: "ollama", providerEndpoint: "https://ollama.example.com", providerModel: "llama3.2" })
    );
    expect(await provider.complete("system", "message")).toBe("Ollama response");
  });
});

describe("OpenAICompatibleProvider.complete: happy path (grok)", () => {
  it("returns content and hits api.x.ai with the default grok model", async () => {
    process.env.XAI_API_KEY = "test-xai-key";
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Grok response" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const provider = getProvider(makeAgent({ provider: "grok" }));
    expect(await provider.complete("system", "message")).toBe("Grok response");
    const [url, init] = mockPublicHttpFetch.mock.calls.at(-1)!;
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    expect((JSON.parse((init as RequestInit).body as string) as { model: string }).model).toBe("grok-4.20");
    delete process.env.XAI_API_KEY;
  });
});

describe("OpenAICompatibleProvider.complete: HTTP error response", () => {
  it("throws and includes status when provider returns non-OK", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 })
    );
    const provider = getProvider(
      makeAgent({ provider: "ollama", providerEndpoint: "https://ollama.example.com" })
    );
    await expect(provider.complete("system", "message")).rejects.toThrow(/503/);
  });
});

describe("OpenAICompatibleProvider.complete: empty or null content", () => {
  it("throws when choices array is empty", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const provider = getProvider(
      makeAgent({ provider: "ollama", providerEndpoint: "https://ollama.example.com" })
    );
    await expect(provider.complete("system", "message")).rejects.toThrow(/No content/);
  });

  it("throws when choice content is null", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const provider = getProvider(
      makeAgent({ provider: "ollama", providerEndpoint: "https://ollama.example.com" })
    );
    await expect(provider.complete("system", "message")).rejects.toThrow(/No content/);
  });
});

// ── OpenAICompatibleProvider.stream() ────────────────────────────────────────

describe("OpenAICompatibleProvider.stream: SSE parsing", () => {
  it("yields text chunks, skips malformed lines, stops at [DONE]", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      "data: not-json-at-all",
      "data: [DONE]",
      'data: {"choices":[{"delta":{"content":"should-not-appear"}}]}',
    ].join("\n");

    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );
    const provider = getProvider(
      makeAgent({ provider: "ollama", providerEndpoint: "https://ollama.example.com" })
    );
    const chunks: string[] = [];
    for await (const chunk of provider.stream("system", "message")) chunks.push(chunk);
    expect(chunks).toEqual(["Hello ", "world"]);
  });

  it("throws when the stream endpoint returns non-OK status", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response("Bad Request", { status: 400 })
    );
    const provider = getProvider(
      makeAgent({ provider: "ollama", providerEndpoint: "https://ollama.example.com" })
    );
    await expect(async () => {
      for await (const _chunk of provider.stream("system", "message")) { /* noop */ }
    }).rejects.toThrow(/400/);
  });
});

// ── OpenAI provider via runWithProvider ───────────────────────────────────────

describe("runWithProvider: openai provider", () => {
  it("calls OpenAI-compatible endpoint and returns content", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    mockPublicHttpFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "GPT response" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const result = await runWithProvider(
      makeAgent({ provider: "openai", agentId: "gpt-agent" }),
      "Hello"
    );
    expect(result).toBe("GPT response");
  });
});
