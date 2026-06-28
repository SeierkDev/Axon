// Phase 8: composable workflow templates.
//
// A template is a reusable, parameterized workflow definition — an ordered agent
// chain plus a task template that may contain {{placeholders}}. Define it once,
// then instantiate it (with parameter values) to run a real workflow, without
// re-wiring the steps each time. Templates can be shared and instantiated by
// other agents, who run them as themselves.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { getAgentById } from "./agents";
import { createWorkflow, type Workflow } from "./workflows";
import { logger } from "./logger";

export interface WorkflowTemplate {
  templateId: string;
  fromAgent: string;
  name: string;
  description?: string;
  agents: string[];
  taskTemplate: string;
  parameters: string[]; // placeholder names extracted from taskTemplate
  createdAt: string;
}

interface TemplateRow {
  template_id: string;
  from_agent: string;
  name: string;
  description: string | null;
  agents: string;
  task_template: string;
  parameters: string;
  created_at: string;
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rowToTemplate(row: TemplateRow): WorkflowTemplate {
  return {
    templateId: row.template_id,
    fromAgent: row.from_agent,
    name: row.name,
    description: row.description ?? undefined,
    agents: parseJsonArray(row.agents),
    taskTemplate: row.task_template,
    parameters: parseJsonArray(row.parameters),
    createdAt: row.created_at,
  };
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// Distinct {{placeholder}} names referenced in a task template, in first-seen order.
export function extractPlaceholders(taskTemplate: string): string[] {
  const seen = new Set<string>();
  for (const m of taskTemplate.matchAll(PLACEHOLDER_RE)) seen.add(m[1]);
  return [...seen];
}

// Fill {{placeholders}} from params. Returns the resolved task, or the names of
// any placeholders that weren't supplied.
export function resolveTask(
  taskTemplate: string,
  params: Record<string, string>
): { ok: true; task: string } | { ok: false; missing: string[] } {
  const missing = extractPlaceholders(taskTemplate).filter((p) => !params[p]);
  if (missing.length > 0) return { ok: false, missing };
  const task = taskTemplate.replace(PLACEHOLDER_RE, (_, name: string) => params[name]);
  return { ok: true, task };
}

export type TemplateErrorCode = "INVALID" | "NOT_FOUND" | "DUPLICATE";
export type CreateTemplateResult =
  | { success: true; template: WorkflowTemplate }
  | { success: false; error: string; code: TemplateErrorCode };

export interface CreateTemplateInput {
  fromAgent: string;
  name: string;
  description?: string;
  agents: string[];
  taskTemplate: string;
}

export function createTemplate(input: CreateTemplateInput): CreateTemplateResult {
  if (input.agents.length < 1) {
    return { success: false, error: "A template needs at least one agent in the chain", code: "INVALID" };
  }
  for (const agentId of input.agents) {
    if (!getAgentById(agentId)) {
      return { success: false, error: `Agent '${agentId}' not found`, code: "NOT_FOUND" };
    }
  }

  const parameters = extractPlaceholders(input.taskTemplate);
  const db = getDb();
  const templateId = randomUUID();
  const createdAt = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO workflow_templates (template_id, from_agent, name, description, agents, task_template, parameters, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      templateId,
      input.fromAgent,
      input.name,
      input.description ?? null,
      JSON.stringify(input.agents),
      input.taskTemplate,
      JSON.stringify(parameters),
      createdAt
    );
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      return { success: false, error: `You already have a template named '${input.name}'`, code: "DUPLICATE" };
    }
    throw err;
  }
  void syncToTurso();
  logger.info("workflow_template.created", "Workflow template created", { templateId, fromAgent: input.fromAgent });
  return { success: true, template: getTemplateById(templateId)! };
}

export function getTemplateById(templateId: string): WorkflowTemplate | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_templates WHERE template_id = ?")
    .get(templateId) as TemplateRow | undefined;
  return row ? rowToTemplate(row) : null;
}

export interface ListTemplatesOptions {
  from?: string;
  limit?: number;
}

export function listTemplates(opts: ListTemplatesOptions = {}): WorkflowTemplate[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = getDb()
    .prepare(
      `SELECT * FROM workflow_templates
       WHERE (? IS NULL OR from_agent = ?)
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(opts.from ?? null, opts.from ?? null, limit) as TemplateRow[];
  return rows.map(rowToTemplate);
}

export function deleteTemplate(templateId: string): boolean {
  const changes = getDb().prepare("DELETE FROM workflow_templates WHERE template_id = ?").run(templateId).changes;
  void syncToTurso();
  return changes > 0;
}

export type InstantiateResult =
  | { success: true; workflow: Workflow }
  | { success: false; error: string; code: "NOT_FOUND" | "INVALID" };

// Run a template as `fromAgent` (the caller) with the given parameter values:
// resolve the task, then create a real workflow on the template's agent chain.
export function instantiateTemplate(
  templateId: string,
  fromAgent: string,
  params: Record<string, string>
): InstantiateResult {
  const template = getTemplateById(templateId);
  if (!template) return { success: false, error: "Template not found", code: "NOT_FOUND" };

  const resolved = resolveTask(template.taskTemplate, params);
  if (!resolved.ok) {
    return { success: false, error: `Missing parameter(s): ${resolved.missing.join(", ")}`, code: "INVALID" };
  }

  // Re-validate the chain at run time — an agent may have been removed since the
  // template was created. Fail cleanly instead of starting a doomed workflow.
  const missingAgent = template.agents.find((agentId) => !getAgentById(agentId));
  if (missingAgent) {
    return { success: false, error: `Agent '${missingAgent}' in this template no longer exists`, code: "INVALID" };
  }

  let workflow: Workflow;
  try {
    workflow = createWorkflow({ fromAgent, agents: template.agents, task: resolved.task });
  } catch (err) {
    // createWorkflow throws (and rolls itself back) if the first step can't be
    // created. Surface a clean error rather than letting the route 500.
    return { success: false, error: err instanceof Error ? err.message : "Failed to start workflow", code: "INVALID" };
  }

  logger.info("workflow_template.instantiated", "Workflow template instantiated", {
    templateId,
    workflowId: workflow.workflowId,
    fromAgent,
  });
  return { success: true, workflow };
}
