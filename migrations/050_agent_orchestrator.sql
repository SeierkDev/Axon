-- Hosted agents that hire. An "orchestrator" agent, when hired for a task, doesn't
-- answer with a single model call — it decomposes the job, hires specialists from
-- the marketplace (paid from its own balance, within its budget), and synthesizes
-- the result. This flag marks an agent as an orchestrator; its execution path in
-- the worker branches to the orchestration engine.
ALTER TABLE agents ADD COLUMN orchestrator INTEGER NOT NULL DEFAULT 0;
