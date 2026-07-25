// The LLM tool adapter — tool shapes, formatters, and dispatch. The `axon_receipt`
// tool is network-free, so the hire/find execute paths (which need a live client)
// aren't exercised here; those are covered by hire.test.ts.

import { describe, it, expect } from "vitest";
import { buildAxonTools, toOpenAITools, toAnthropicTools, runAxonTool } from "../src/tools";
import type { AxonClient } from "../src/client";

const fakeClient = {} as AxonClient; // the receipt + formatting paths never touch it

describe("axon tools", () => {
  it("ships the three tools with stable names and object schemas", () => {
    const tools = buildAxonTools(fakeClient);
    expect(tools.map((t) => t.name)).toEqual([
      "axon_hire_specialist",
      "axon_find_specialists",
      "axon_receipt",
    ]);
    for (const t of tools) expect(t.parameters).toMatchObject({ type: "object" });
  });

  it("axon_receipt builds a verifiable URL with no network call", async () => {
    const tools = buildAxonTools(fakeClient, { origin: "https://axon-agents.com/" });
    const out = await runAxonTool(tools, "axon_receipt", { task_id: "abc123" });
    expect(out).toEqual({ taskId: "abc123", receiptUrl: "https://axon-agents.com/r/abc123" });
  });

  it("formats for OpenAI and Anthropic", () => {
    const tools = buildAxonTools(fakeClient);
    expect(toOpenAITools(tools)[0]).toMatchObject({
      type: "function",
      function: { name: "axon_hire_specialist" },
    });
    expect(toAnthropicTools(tools)[0]).toMatchObject({
      name: "axon_hire_specialist",
      input_schema: { type: "object" },
    });
  });

  it("runAxonTool throws on an unknown tool", async () => {
    const tools = buildAxonTools(fakeClient);
    await expect(runAxonTool(tools, "nope", {})).rejects.toThrow(/unknown Axon tool/);
  });

  it("axon_hire_specialist rejects an empty task before touching the client", async () => {
    const tools = buildAxonTools(fakeClient); // fakeClient has no run() — a real call would throw
    await expect(runAxonTool(tools, "axon_hire_specialist", { task: "   " })).rejects.toThrow(
      /requires a non-empty `task`/,
    );
  });
});
