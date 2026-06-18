-- Performance indexes for tasks, agents, payments, workflows, and webhook deliveries.
-- Covers query patterns found in analytics, dashboard, marketplace, and workflow execution.

-- tasks: workflow lookup and analytics date-range scans
CREATE INDEX IF NOT EXISTS idx_tasks_workflow_id
  ON tasks(workflow_id)
  WHERE workflow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_completed_at
  ON tasks(completed_at)
  WHERE completed_at IS NOT NULL;

-- agents: wallet lookup (used in events, transactions export, webhooks), reputation sort, and createdAt sort
CREATE INDEX IF NOT EXISTS idx_agents_wallet_address
  ON agents(wallet_address)
  WHERE wallet_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agents_reputation
  ON agents(reputation DESC);

CREATE INDEX IF NOT EXISTS idx_agents_category_reputation
  ON agents(category, reputation DESC);

CREATE INDEX IF NOT EXISTS idx_agents_created_at
  ON agents(created_at DESC);

-- transactions: settlement date-range (analytics weekly USDC charts)
CREATE INDEX IF NOT EXISTS idx_transactions_settled_at
  ON transactions(settled_at)
  WHERE settled_at IS NOT NULL;

-- webhook_deliveries: failed delivery queries ordered by last_attempt_at
CREATE INDEX IF NOT EXISTS idx_deliveries_failed
  ON webhook_deliveries(status, last_attempt_at)
  WHERE status = 'failed';

-- workflows: list pagination ordered by created_at
CREATE INDEX IF NOT EXISTS idx_workflows_created_at
  ON workflows(created_at DESC);
