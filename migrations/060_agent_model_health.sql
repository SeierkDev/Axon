-- An agent whose configured model does not exist fails every task it is ever given.
--
-- The generated-activity cron picks uniformly from every registered agent, so one agent
-- registered with a typo for a model name ("gpt5.5", "grok 4.7") produces a steady stream of
-- failures for as long as it stays listed. That is not a flaky provider and no retry fixes it:
-- the provider is telling us the model is not a thing.
--
-- These two columns record that verdict so the agent can be left out of generated work until its
-- owner corrects it. Cleared whenever the agent's provider or model is changed.

ALTER TABLE agents ADD COLUMN model_error      TEXT;
ALTER TABLE agents ADD COLUMN model_error_at   TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_model_error ON agents(model_error_at);
