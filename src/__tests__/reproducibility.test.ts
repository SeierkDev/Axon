// Reproducibility proofs (Proof Layer #2). Contracts:
//  (1) the verdict logic is deterministic and matches published rules;
//  (2) the similarity is a recomputable lexical cosine (no model needed);
//  (3) the content hash is stable (excludes the timestamp);
//  (4) the public proof never leaks output text.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import {
  reproduceTask,
  getReproProof,
  compareOutputs,
  lexicalSimilarity,
  hashReproProof,
  sampleReproducibility,
  EQUIVALENCE_THRESHOLD,
} from "@/lib/reproducibility";
import { createTask, startTask, completeTask, getTaskById } from "@/lib/tasks";
import { createAgent, getAgentById } from "@/lib/agents";
import { safeAppendTraceEvent, traceIdForTask } from "@/lib/traceEvents";
import type { Agent } from "@/sdk/types";

let n = 0;
function makeAgent(overrides: Partial<Agent> = {}): Agent {
  n++;
  const a: Agent = {
    agentId: `repro-agent-${n}-${randomUUID().slice(0, 6)}`,
    name: "Repro Worker",
    capabilities: ["research"],
    publicKey: `pk-repro-${n}`,
    provider: "anthropic",
    reputation: 0,
    category: "Research",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  createAgent(a);
  return a;
}

// Ensure a fixed-id agent exists (for the price-agent guard, which keys on id).
function ensureAgent(agentId: string): Agent {
  const existing = getAgentById(agentId);
  if (existing) return existing;
  const a: Agent = {
    agentId,
    name: agentId,
    capabilities: ["research"],
    publicKey: `pk-${agentId}`,
    provider: "anthropic",
    reputation: 0,
    category: "Research",
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

function taskTo(to: string, output: string, taskText = "summarize the protocol"): string {
  const from = makeAgent();
  const t = createTask({ fromAgent: from.agentId, toAgent: to, task: taskText });
  startTask(t.taskId);
  completeTask(t.taskId, output);
  return t.taskId;
}

function completedTask(output: string, taskText = "summarize the protocol"): string {
  return taskTo(makeAgent().agentId, output, taskText);
}

describe("lexicalSimilarity", () => {
  it("is 1 for identical text and for two empty strings", () => {
    expect(lexicalSimilarity("alpha beta gamma", "alpha beta gamma")).toBe(1);
    expect(lexicalSimilarity("", "")).toBe(1);
  });

  it("is 0 for disjoint token sets and for empty-vs-nonempty", () => {
    expect(lexicalSimilarity("alpha beta", "gamma delta")).toBe(0);
    expect(lexicalSimilarity("", "gamma")).toBe(0);
  });

  it("is symmetric and bounded in [0,1]", () => {
    const a = "the quick brown fox jumps";
    const b = "the quick brown dog runs";
    const s = lexicalSimilarity(a, b);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
    expect(lexicalSimilarity(b, a)).toBeCloseTo(s, 12);
  });
});

describe("compareOutputs", () => {
  it("returns exact + matching hashes for identical output", () => {
    const c = compareOutputs("same output text", "same output text");
    expect(c.verdict).toBe("exact");
    expect(c.similarity).toBe(1);
    expect(c.originalOutputHash).toBe(c.reproducedOutputHash);
  });

  it("returns equivalent (hashes differ, similarity >= threshold) for a near-copy", () => {
    const original = "the quick brown fox jumps over the lazy dog";
    const c = compareOutputs(original, original + " today");
    expect(c.originalOutputHash).not.toBe(c.reproducedOutputHash);
    expect(c.similarity).toBeGreaterThanOrEqual(EQUIVALENCE_THRESHOLD);
    expect(c.verdict).toBe("equivalent");
  });

  it("returns divergent for unrelated output", () => {
    const c = compareOutputs("alpha beta gamma delta", "wholly unrelated content here");
    expect(c.verdict).toBe("divergent");
  });
});

describe("reproduceTask", () => {
  it("records an exact proof when the re-run matches, retrievable via getReproProof", async () => {
    const output = "The canonical answer, verbatim.";
    const taskId = completedTask(output);
    const proof = await reproduceTask(taskId, { runner: async () => output });

    expect(proof.verdict).toBe("exact");
    expect(proof.similarity).toBe(1);
    expect(proof.originalOutputHash).toBe(proof.reproducedOutputHash);

    const stored = getReproProof(taskId);
    expect(stored).not.toBeNull();
    expect(stored!.contentHash).toBe(proof.contentHash);
    expect(stored!.verdict).toBe("exact");
  });

  it("records equivalent when the re-run is a near-copy", async () => {
    const original = "the quick brown fox jumps over the lazy dog";
    const taskId = completedTask(original);
    const proof = await reproduceTask(taskId, { runner: async () => original + " today" });
    expect(proof.verdict).toBe("equivalent");
    expect(proof.originalOutputHash).not.toBe(proof.reproducedOutputHash);
  });

  it("records divergent when the re-run is unrelated", async () => {
    const taskId = completedTask("alpha beta gamma delta epsilon");
    const proof = await reproduceTask(taskId, { runner: async () => "completely different words entirely" });
    expect(proof.verdict).toBe("divergent");
  });

  it("produces a stable content hash independent of the timestamp", async () => {
    const output = "deterministic content";
    const taskId = completedTask(output);
    const a = await reproduceTask(taskId, { runner: async () => output, persist: false });
    const b = await reproduceTask(taskId, { runner: async () => output, persist: false });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("content hash is recomputable from ONLY the public proof fields", async () => {
    const output = "recompute this exactly";
    const taskId = completedTask(output);
    const proof = await reproduceTask(taskId, { runner: async () => output });
    // A third party recomputes the content hash from the public proof alone — if
    // any hashed field weren't exposed, this would diverge.
    const recomputed = hashReproProof({
      taskId: proof.taskId,
      verdict: proof.verdict,
      similarity: proof.similarity,
      originalOutputHash: proof.originalOutputHash,
      reproducedOutputHash: proof.reproducedOutputHash,
      model: proof.model,
      temperature: proof.temperature,
      method: proof.method,
    });
    expect(recomputed).toBe(proof.contentHash);
  });

  it("never leaks the output text in the public proof", async () => {
    const original = "SECRET_ORIGINAL_PAYLOAD_XYZ confidential deliverable";
    const reproduced = "SECRET_REPRO_PAYLOAD_XYZ confidential deliverable";
    const taskId = completedTask(original);
    await reproduceTask(taskId, { runner: async () => reproduced });

    const serialized = JSON.stringify(getReproProof(taskId));
    expect(serialized).not.toContain("SECRET_ORIGINAL_PAYLOAD_XYZ");
    expect(serialized).not.toContain("SECRET_REPRO_PAYLOAD_XYZ");
  });

  it("throws for a task with no completed output", async () => {
    const from = makeAgent();
    const to = makeAgent();
    const t = createTask({ fromAgent: from.agentId, toAgent: to.agentId, task: "not done yet" });
    await expect(reproduceTask(t.taskId)).rejects.toThrow(/no completed output/);
  });

  it("refuses to reproduce agents with live runtime input (price agents)", async () => {
    ensureAgent("crypto-agent");
    const taskId = taskTo("crypto-agent", "BTC looks strong today");
    await expect(reproduceTask(taskId, { runner: async () => "x" })).rejects.toThrow(
      /can't be deterministically reproduced/,
    );
  });

  it("records the concrete model that ran, never a misleading null", async () => {
    const to = makeAgent({ providerModel: "claude-haiku-4-5" });
    const taskId = taskTo(to.agentId, "deterministic body");
    const proof = await reproduceTask(taskId, { runner: async () => "deterministic body" });
    expect(proof.model).toBe("claude-haiku-4-5");
  });

  it("records the concrete non-anthropic default model, not a misleading null", async () => {
    const to = makeAgent({ provider: "ollama", providerEndpoint: "https://ollama.example.com" });
    const taskId = taskTo(to.agentId, "deterministic body");
    const proof = await reproduceTask(taskId, { runner: async () => "deterministic body" });
    expect(proof.model).toBe("llama3.2");
  });

  it("records the grok default model for an unconfigured grok agent", async () => {
    const to = makeAgent({ provider: "grok" });
    const taskId = taskTo(to.agentId, "deterministic body");
    const proof = await reproduceTask(taskId, { runner: async () => "deterministic body" });
    expect(proof.model).toBe("grok-4.20");
  });

  it("refuses to reproduce a task that ran on an external agent endpoint", async () => {
    const to = makeAgent({ endpoint: "https://external.example.com/agent" });
    const taskId = taskTo(to.agentId, "external output");
    await expect(reproduceTask(taskId, { runner: async () => "x" })).rejects.toThrow(/external agent endpoint/);
  });

  it("refuses to reproduce a task that ran via an external MCP server", async () => {
    const to = makeAgent();
    const taskId = taskTo(to.agentId, "mcp output");
    safeAppendTraceEvent({ traceId: traceIdForTask(taskId), taskId, kind: "step.model", model: "mcp" });
    // sanity: the seeded trace event is what the guard reads
    expect(getTaskById(taskId)?.status).toBe("completed");
    await expect(reproduceTask(taskId, { runner: async () => "x" })).rejects.toThrow(/external MCP/);
  });
});

describe("sampleReproducibility", () => {
  it("reproduces recent eligible tasks and skips already-proofed and network-activity ones", async () => {
    const output = "sampled deliverable body";
    const eligible = completedTask(output);

    // Already proofed — must not be re-sampled.
    const proofed = completedTask("already proven output");
    await reproduceTask(proofed, { runner: async () => "already proven output" });

    // Network-activity task — completes from prepared results; never sampled.
    const from = makeAgent();
    const worker = makeAgent();
    const activity = createTask({
      fromAgent: from.agentId,
      toAgent: worker.agentId,
      task: "scheduled network activity",
      context: { source: "axon-network-activity", automated: true },
    });
    startTask(activity.taskId);
    completeTask(activity.taskId, "prepared output");

    const samples = await sampleReproducibility(10, { runner: async () => output });
    const ids = samples.map((s) => s.taskId);
    expect(ids).toContain(eligible);
    expect(ids).not.toContain(proofed);
    expect(ids).not.toContain(activity.taskId);

    // The sampled task now carries a real, public proof.
    const proof = getReproProof(eligible);
    expect(proof).not.toBeNull();
    expect(proof!.verdict).toBe("exact");
  });

  it("skips non-reproducible tasks without failing the pass", async () => {
    ensureAgent("crypto-agent");
    const priceTask = taskTo("crypto-agent", "live-data output");
    const normal = completedTask("plain body");
    const samples = await sampleReproducibility(10, { runner: async () => "plain body" });
    const ids = samples.map((s) => s.taskId);
    expect(ids).not.toContain(priceTask);
    expect(ids).toContain(normal);
  });
});
