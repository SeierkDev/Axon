// Tests for the agent tool loop in providers.ts — completeWithTools() and
// runWithProviderTools(). The Anthropic SDK is mocked with a class stub so the
// loop's control flow (tool_use → execute → feed back → answer) is exercised
// without any network. Kept in its own file so the mock stays isolated.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockStream, mockRun, BadRequestError } = vi.hoisted(() => ({
  mockStream: vi.fn(),
  mockRun: vi.fn(),
  // The provider narrows on the SDK's typed error classes, so the stub carries one.
  BadRequestError: class BadRequestError extends Error {},
}));

vi.mock("@anthropic-ai/sdk", () => {
  const Stub = class {
    messages = { create: vi.fn(), stream: mockStream };
    constructor() {}
  };
  (Stub as unknown as { BadRequestError: unknown }).BadRequestError = BadRequestError;
  return { default: Stub };
});

import type { Agent } from "@/sdk/types";
import type { ResolvedTools, LocalTool } from "@/lib/agentTools";
import { getProvider, runWithProviderTools } from "@/lib/providers";
import type { ToolCallEvent } from "@/lib/providers";
import { MAX_TOOL_STEPS } from "@/lib/agentToolLimits";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-mock";
});

afterEach(() => {
  mockStream.mockReset();
  mockRun.mockReset();
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

const localTool = (): LocalTool => ({
  name: "mcp_srv1_lookup",
  description: "Look something up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  label: "analyst/lookup",
  run: mockRun,
});

function makeTools(overrides: Partial<ResolvedTools> = {}): ResolvedTools {
  return {
    serverTools: [{ type: "web_search_20260209", name: "web_search" }],
    localTools: [localTool()],
    grants: ["web_search", "mcp:srv1"],
    ...overrides,
  };
}

// Shorthand for a mocked model turn.
function turn(content: unknown[], stopReason = "end_turn") {
  return {
    finalMessage: () =>
      Promise.resolve({ content, stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 } }),
  };
}

// ── The loop ──────────────────────────────────────────────────────────────────

describe("completeWithTools: runs a tool then answers", () => {
  it("executes the requested tool and feeds the result back before answering", async () => {
    mockRun.mockResolvedValueOnce("TVL is $4.2B");
    mockStream
      .mockReturnValueOnce(
        turn([{ type: "tool_use", id: "tu_1", name: "mcp_srv1_lookup", input: { q: "tvl" } }], "tool_use"),
      )
      .mockReturnValueOnce(turn([{ type: "text", text: "Total value locked is $4.2B." }]));

    const provider = getProvider(makeAgent());
    const calls: ToolCallEvent[] = [];
    const out = await provider.completeWithTools!("sys", "what is TVL?", 1000, makeTools(), { onToolCall: (e) => calls.push(e) });

    expect(out).toBe("Total value locked is $4.2B.");
    expect(mockRun).toHaveBeenCalledWith({ q: "tvl" });

    // The second request carries the assistant turn plus the tool result.
    const second = mockStream.mock.calls[1][0] as { messages: { role: string; content: unknown }[] };
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "TVL is $4.2B" }],
    });

    // …and the call is reported for the receipt, with the raw args/result so the
    // caller can hash them.
    expect(calls).toEqual([
      expect.objectContaining({ tool: "analyst/lookup", kind: "mcp", ok: true, input: '{"q":"tvl"}' }),
    ]);
  });
});

describe("completeWithTools: a failing tool doesn't fail the task", () => {
  it("returns the error to the model as an is_error result and keeps going", async () => {
    mockRun.mockRejectedValueOnce(new Error("server unreachable"));
    mockStream
      .mockReturnValueOnce(
        turn([{ type: "tool_use", id: "tu_1", name: "mcp_srv1_lookup", input: { q: "x" } }], "tool_use"),
      )
      .mockReturnValueOnce(turn([{ type: "text", text: "I could not reach the source." }]));

    const provider = getProvider(makeAgent());
    const calls: ToolCallEvent[] = [];
    const out = await provider.completeWithTools!("sys", "go", 1000, makeTools(), { onToolCall: (e) => calls.push(e) });

    expect(out).toBe("I could not reach the source.");
    const second = mockStream.mock.calls[1][0] as { messages: { content: unknown }[] };
    expect(second.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "Error: server unreachable", is_error: true },
    ]);
    expect(calls[0]).toMatchObject({ ok: false, error: "server unreachable" });
  });
});

describe("completeWithTools: unknown tool name", () => {
  it("tells the model instead of throwing", async () => {
    mockStream
      .mockReturnValueOnce(turn([{ type: "tool_use", id: "tu_1", name: "not_a_tool", input: {} }], "tool_use"))
      .mockReturnValueOnce(turn([{ type: "text", text: "done" }]));

    const provider = getProvider(makeAgent());
    const out = await provider.completeWithTools!("sys", "go", 1000, makeTools());
    expect(out).toBe("done");
    const second = mockStream.mock.calls[1][0] as { messages: { content: { is_error?: boolean }[] }[] };
    expect(second.messages[2].content[0].is_error).toBe(true);
  });
});

describe("completeWithTools: parallel tool calls", () => {
  it("returns every result in a single user message", async () => {
    mockRun.mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    mockStream
      .mockReturnValueOnce(
        turn(
          [
            { type: "tool_use", id: "tu_1", name: "mcp_srv1_lookup", input: { q: "a" } },
            { type: "tool_use", id: "tu_2", name: "mcp_srv1_lookup", input: { q: "b" } },
          ],
          "tool_use",
        ),
      )
      .mockReturnValueOnce(turn([{ type: "text", text: "both" }]));

    const provider = getProvider(makeAgent());
    expect(await provider.completeWithTools!("sys", "go", 1000, makeTools())).toBe("both");

    const second = mockStream.mock.calls[1][0] as { messages: { content: unknown[] }[] };
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2].content).toHaveLength(2);
  });
});

// ── Server-side tools ─────────────────────────────────────────────────────────

describe("completeWithTools: reports Anthropic-executed tools", () => {
  it("pairs server_tool_use with its result and records both outcomes", async () => {
    mockStream.mockReturnValueOnce(
      turn([
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "solana tvl" } },
        { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://x" }] },
        { type: "server_tool_use", id: "srv_2", name: "web_fetch", input: { url: "https://x" } },
        { type: "web_fetch_tool_result", tool_use_id: "srv_2", content: { error_code: "unavailable" } },
        { type: "text", text: "Here is what I found." },
      ]),
    );

    const provider = getProvider(makeAgent());
    const calls: ToolCallEvent[] = [];
    const out = await provider.completeWithTools!("sys", "go", 1000, makeTools(), { onToolCall: (e) => calls.push(e) });

    expect(out).toBe("Here is what I found.");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ tool: "web_search", kind: "web_search", ok: true, latencyMs: null });
    expect(calls[1]).toMatchObject({ tool: "web_fetch", kind: "web_fetch", ok: false, error: "unavailable" });
  });

  it("resumes a paused turn without inventing a user message", async () => {
    mockStream
      .mockReturnValueOnce(turn([{ type: "text", text: "searching" }], "pause_turn"))
      .mockReturnValueOnce(turn([{ type: "text", text: "final answer" }]));

    const provider = getProvider(makeAgent());
    expect(await provider.completeWithTools!("sys", "go", 1000, makeTools())).toBe("final answer");
    const second = mockStream.mock.calls[1][0] as { messages: { role: string }[] };
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

// ── Bounds ────────────────────────────────────────────────────────────────────

describe("completeWithTools: step cap", () => {
  it("stops looping and forces a final answer with tools switched off", async () => {
    mockRun.mockResolvedValue("still going");
    // The model asks for a tool on every single turn.
    for (let i = 0; i < MAX_TOOL_STEPS; i++) {
      mockStream.mockReturnValueOnce(
        turn([{ type: "tool_use", id: `tu_${i}`, name: "mcp_srv1_lookup", input: {} }], "tool_use"),
      );
    }
    mockStream.mockReturnValueOnce(turn([{ type: "text", text: "wrapping up" }]));

    const provider = getProvider(makeAgent());
    const out = await provider.completeWithTools!("sys", "go", 1000, makeTools());

    expect(out).toBe("wrapping up");
    expect(mockStream).toHaveBeenCalledTimes(MAX_TOOL_STEPS + 1);
    // The final pass disables tool use so the loop can't be extended further.
    const last = mockStream.mock.calls[MAX_TOOL_STEPS][0] as { tool_choice?: { type: string } };
    expect(last.tool_choice).toEqual({ type: "none" });
  });
});

describe("completeWithTools: oversized tool output", () => {
  it("truncates before feeding it back so one tool can't blow the context", async () => {
    mockRun.mockResolvedValueOnce("x".repeat(50_000));
    mockStream
      .mockReturnValueOnce(turn([{ type: "tool_use", id: "tu_1", name: "mcp_srv1_lookup", input: {} }], "tool_use"))
      .mockReturnValueOnce(turn([{ type: "text", text: "ok" }]));

    const provider = getProvider(makeAgent());
    await provider.completeWithTools!("sys", "go", 1000, makeTools());

    const second = mockStream.mock.calls[1][0] as { messages: { content: { content: string }[] }[] };
    const fedBack = second.messages[2].content[0].content;
    expect(fedBack.length).toBeLessThan(50_000);
    expect(fedBack.endsWith("…[truncated]")).toBe(true);
  });
});

describe("completeWithTools: truncation", () => {
  it("does not run a tool call that was cut off mid-arguments", async () => {
    mockStream.mockReturnValueOnce(
      turn(
        [
          { type: "text", text: "Partial findings so far." },
          { type: "tool_use", id: "tu_1", name: "mcp_srv1_lookup", input: {} },
        ],
        "max_tokens",
      ),
    );

    const provider = getProvider(makeAgent());
    const out = await provider.completeWithTools!("sys", "go", 1000, makeTools());

    expect(out).toBe("Partial findings so far.");
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("fails the task rather than settling payment for an empty answer", async () => {
    mockStream.mockReturnValueOnce(
      turn([{ type: "tool_use", id: "tu_1", name: "mcp_srv1_lookup", input: {} }], "max_tokens"),
    );
    const provider = getProvider(makeAgent());
    await expect(provider.completeWithTools!("sys", "go", 1000, makeTools())).rejects.toThrow(
      /no answer|No text response/i,
    );
  });
});

describe("completeWithTools: abort", () => {
  it("stops between rounds when the caller has gone away", async () => {
    // A tool loop is several model calls behind one await, so a disconnected
    // client must be able to stop it paying for the remaining rounds.
    const abort = new AbortController();
    mockRun.mockImplementation(async () => {
      abort.abort(); // the client disconnects while the first tool runs
      return "result";
    });
    mockStream.mockReturnValue(
      turn([{ type: "tool_use", id: "tu_1", name: "mcp_srv1_lookup", input: {} }], "tool_use"),
    );

    const provider = getProvider(makeAgent());
    await expect(
      provider.completeWithTools!("sys", "go", 1000, makeTools(), { signal: abort.signal }),
    ).rejects.toThrow(/aborted/i);

    // One round ran, not the full six.
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});

// ── Model fallback still applies ──────────────────────────────────────────────

describe("completeWithTools: refusal", () => {
  it("re-runs the whole tool loop on the fallback model", async () => {
    mockStream
      .mockReturnValueOnce(turn([], "refusal"))
      .mockReturnValueOnce(turn([{ type: "text", text: "answered by the fallback" }]));

    const provider = getProvider(makeAgent());
    expect(await provider.completeWithTools!("sys", "go", 1000, makeTools())).toBe("answered by the fallback");
    const second = mockStream.mock.calls[1][0] as { model: string };
    expect(second.model).toBe("claude-opus-4-8");
  });
});

// ── runWithProviderTools ──────────────────────────────────────────────────────

describe("runWithProviderTools", () => {
  it("passes the tool definitions through for an Anthropic agent", async () => {
    mockStream.mockReturnValueOnce(turn([{ type: "text", text: "hi" }]));
    const out = await runWithProviderTools(makeAgent(), "go", 1000, makeTools());
    expect(out).toBe("hi");
    const req = mockStream.mock.calls[0][0] as { tools: { name: string }[] };
    expect(req.tools.map((t) => t.name)).toEqual(["web_search", "mcp_srv1_lookup"]);
  });

  it("answers without tools when the API rejects the tool request", async () => {
    // e.g. an agent pinned to a model that doesn't offer server-side tools.
    mockStream.mockImplementationOnce(() => {
      throw new BadRequestError("tools.0: unsupported tool type");
    });
    mockStream.mockReturnValueOnce(turn([{ type: "text", text: "answered without tools" }]));

    const out = await runWithProviderTools(makeAgent(), "go", 1000, makeTools());
    expect(out).toBe("answered without tools");
    // The retry carries no tools at all.
    expect((mockStream.mock.calls[1][0] as { tools?: unknown }).tools).toBeUndefined();
  });

  it("degrades to a plain single call for a provider without tool support", async () => {
    process.env.OPENAI_API_KEY = "openai-test-key";
    const agent = makeAgent({ provider: "openai" });
    const provider = getProvider(agent);
    expect(provider.completeWithTools).toBeUndefined();
  });
});
