import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import {
  createTemplate,
  getTemplateById,
  listTemplates,
  deleteTemplate,
  instantiateTemplate,
  extractPlaceholders,
  resolveTask,
} from "@/lib/workflowTemplates";
import { getWorkflow } from "@/lib/workflows";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

let counter = 0;
function makeAgent(): Agent {
  counter++;
  const a: Agent = {
    agentId: `tmpl-${counter}`,
    name: `Template Agent ${counter}`,
    capabilities: ["x"],
    publicKey: `pk-tmpl-${counter}`,
    walletAddress: "11111111111111111111111111111111",
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

describe("workflow templates", () => {
  it("extractPlaceholders finds distinct {{names}} in first-seen order", () => {
    expect(extractPlaceholders("Research {{topic}}, then summarize {{topic}} for {{audience}}")).toEqual([
      "topic",
      "audience",
    ]);
  });

  it("resolveTask fills placeholders and reports missing ones", () => {
    expect(resolveTask("Hi {{name}}", { name: "x402" })).toEqual({ ok: true, task: "Hi x402" });
    const r = resolveTask("Hi {{name}} from {{place}}", { name: "x402" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["place"]);
  });

  it("creates and lists a template; parameters are derived from the task", () => {
    const a = makeAgent();
    const b = makeAgent();
    const r = createTemplate({
      fromAgent: a.agentId,
      name: `pipeline-${counter}`,
      agents: [a.agentId, b.agentId],
      taskTemplate: "Research {{topic}}",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.template.parameters).toEqual(["topic"]);
    expect(getTemplateById(r.template.templateId)?.agents).toEqual([a.agentId, b.agentId]);
    expect(listTemplates({ from: a.agentId }).some((t) => t.templateId === r.template.templateId)).toBe(true);
  });

  it("rejects a template with no agents", () => {
    const a = makeAgent();
    const r = createTemplate({ fromAgent: a.agentId, name: `empty-${counter}`, agents: [], taskTemplate: "x" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("rejects an unknown agent in the chain", () => {
    const a = makeAgent();
    const r = createTemplate({
      fromAgent: a.agentId,
      name: `bad-${counter}`,
      agents: [a.agentId, "no-such-agent"],
      taskTemplate: "x",
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });

  it("rejects a duplicate template name for the same owner", () => {
    const a = makeAgent();
    const b = makeAgent();
    const name = `dup-${counter}`;
    createTemplate({ fromAgent: a.agentId, name, agents: [a.agentId], taskTemplate: "x" });
    const r = createTemplate({ fromAgent: a.agentId, name, agents: [b.agentId], taskTemplate: "y" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("DUPLICATE");
  });

  it("instantiates a template into a real workflow with the resolved task", () => {
    const a = makeAgent();
    const b = makeAgent();
    const created = createTemplate({
      fromAgent: a.agentId,
      name: `run-${counter}`,
      agents: [a.agentId, b.agentId],
      taskTemplate: "Summarize {{topic}}",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const r = instantiateTemplate(created.template.templateId, a.agentId, { topic: "x402" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const wf = getWorkflow(r.workflow.workflowId);
    expect(wf?.agents).toEqual([a.agentId, b.agentId]);
    expect(wf?.initialTask).toBe("Summarize x402");
  });

  it("rejects instantiation with missing params", () => {
    const a = makeAgent();
    const created = createTemplate({
      fromAgent: a.agentId,
      name: `miss-${counter}`,
      agents: [a.agentId],
      taskTemplate: "Do {{thing}}",
    });
    if (!created.success) return;
    const r = instantiateTemplate(created.template.templateId, a.agentId, {});
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("rejects instantiation when a chain agent was removed after creation", () => {
    const a = makeAgent();
    const b = makeAgent();
    const created = createTemplate({
      fromAgent: a.agentId,
      name: `gone-${counter}`,
      agents: [a.agentId, b.agentId],
      taskTemplate: "Do it",
    });
    if (!created.success) return;
    getDb().prepare("DELETE FROM agents WHERE agent_id = ?").run(b.agentId);
    const r = instantiateTemplate(created.template.templateId, a.agentId, {});
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("rejects instantiation of an unknown template", () => {
    const a = makeAgent();
    const r = instantiateTemplate(randomUUID(), a.agentId, {});
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });

  it("deletes a template", () => {
    const a = makeAgent();
    const created = createTemplate({ fromAgent: a.agentId, name: `del-${counter}`, agents: [a.agentId], taskTemplate: "x" });
    if (!created.success) return;
    expect(deleteTemplate(created.template.templateId)).toBe(true);
    expect(getTemplateById(created.template.templateId)).toBeNull();
  });
});
