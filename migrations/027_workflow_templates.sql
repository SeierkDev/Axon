-- Phase 8 (Advanced Protocol Features): composable workflow templates.
-- A reusable, parameterized workflow definition — an ordered agent chain plus a
-- task template that may contain {{placeholders}}. Instantiate it with parameter
-- values to spin up a real workflow, without re-wiring the steps each time.

CREATE TABLE IF NOT EXISTS workflow_templates (
  template_id    TEXT PRIMARY KEY,
  from_agent     TEXT NOT NULL,                 -- owner (agent id or wallet)
  name           TEXT NOT NULL,
  description    TEXT,
  agents         TEXT NOT NULL,                 -- JSON array of agent ids (the ordered chain)
  task_template  TEXT NOT NULL,                 -- task string, may contain {{placeholders}}
  parameters     TEXT NOT NULL DEFAULT '[]',    -- JSON array of declared placeholder names
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_templates_from ON workflow_templates (from_agent, created_at);
-- One template name per owner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_templates_name ON workflow_templates (from_agent, name);
