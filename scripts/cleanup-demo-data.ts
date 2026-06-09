import { getDb } from "../src/lib/db";

const DEMO_AGENT_PREFIXES = ["demo-echo-", "smoke-agent-"];
const DEMO_CAPABILITIES = ["demo", "testing"];

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function main() {
  const db = getDb();

  const demoAgents = db.prepare(`
    SELECT DISTINCT agent_id FROM agents
    WHERE ${DEMO_AGENT_PREFIXES.map(() => "agent_id LIKE ?").join(" OR ")}
       OR agent_id IN (
         SELECT agent_id FROM agent_capabilities
         WHERE capability IN (${placeholders(DEMO_CAPABILITIES)})
       )
  `).all(
    ...DEMO_AGENT_PREFIXES.map((prefix) => `${prefix}%`),
    ...DEMO_CAPABILITIES
  ) as { agent_id: string }[];

  const agentIds = demoAgents
    .map((row) => row.agent_id)
    .filter((agentId) => DEMO_AGENT_PREFIXES.some((prefix) => agentId.startsWith(prefix)));

  const agentPh = agentIds.length > 0 ? placeholders(agentIds) : "";
  const taskIds = agentIds.length > 0
    ? db.prepare(`
        SELECT task_id FROM tasks
        WHERE to_agent IN (${agentPh}) OR from_agent IN (${agentPh})
      `).all(...agentIds, ...agentIds) as { task_id: string }[]
    : [];
  const taskIdValues = taskIds.map((row) => row.task_id);
  const taskPh = taskIdValues.length > 0 ? placeholders(taskIdValues) : "";

  const taskLinkedMppChannelIds = taskIdValues.length > 0
    ? db.prepare(`
        SELECT DISTINCT channel_id FROM mpp_debits
        WHERE task_id IN (${taskPh})
      `).all(...taskIdValues) as { channel_id: string }[]
    : [];
  const mockPaymentMppChannelIds = db.prepare(`
    SELECT DISTINCT channel_id FROM mpp_deposits
    WHERE signature LIKE 'mockpay:%:mpp-%'
  `).all() as { channel_id: string }[];
  const mppChannelIdValues = Array.from(new Set([
    ...taskLinkedMppChannelIds.map((row) => row.channel_id),
    ...mockPaymentMppChannelIds.map((row) => row.channel_id),
  ]));
  const mppChannelPh = mppChannelIdValues.length > 0 ? placeholders(mppChannelIdValues) : "";

  const counts = db.transaction(() => {
    const result: Record<string, number> = {};

    if (taskIdValues.length > 0) {
      result.webhookDeliveries = db.prepare(`
        DELETE FROM webhook_deliveries
        WHERE json_extract(payload, '$.taskId') IN (${taskPh})
      `).run(...taskIdValues).changes;

      result.transactions = db.prepare(`
        DELETE FROM transactions WHERE task_id IN (${taskPh})
      `).run(...taskIdValues).changes;

      result.mppDebits = db.prepare(`
        DELETE FROM mpp_debits WHERE task_id IN (${taskPh})
      `).run(...taskIdValues).changes;

      result.tasks = db.prepare(`
        DELETE FROM tasks WHERE task_id IN (${taskPh})
      `).run(...taskIdValues).changes;
    } else {
      result.webhookDeliveries = 0;
      result.transactions = 0;
      result.mppDebits = 0;
      result.tasks = 0;
    }

    if (mppChannelIdValues.length > 0) {
      result.auditEventsMpp = db.prepare(`
        DELETE FROM audit_events
        WHERE resource_type = 'mpp_channel' AND resource_id IN (${mppChannelPh})
      `).run(...mppChannelIdValues).changes;
      result.mppDeposits = db.prepare(`
        DELETE FROM mpp_deposits WHERE channel_id IN (${mppChannelPh})
      `).run(...mppChannelIdValues).changes;
      result.mppChannels = db.prepare(`
        DELETE FROM mpp_channels WHERE channel_id IN (${mppChannelPh})
      `).run(...mppChannelIdValues).changes;
    } else {
      result.auditEventsMpp = 0;
      result.mppDeposits = 0;
      result.mppChannels = 0;
    }

    if (agentIds.length > 0) {
      result.auditEventsAgents = db.prepare(`
        DELETE FROM audit_events
        WHERE owner_agent_id IN (${agentPh}) OR resource_id IN (${agentPh})
      `).run(...agentIds, ...agentIds).changes;

      result.agentCapabilities = db.prepare(`
        DELETE FROM agent_capabilities WHERE agent_id IN (${agentPh})
      `).run(...agentIds).changes;

      result.agentMetrics = db.prepare(`
        DELETE FROM agent_metrics WHERE agent_id IN (${agentPh})
      `).run(...agentIds).changes;

      result.agentBudgets = db.prepare(`
        DELETE FROM agent_budgets WHERE agent_id IN (${agentPh})
      `).run(...agentIds).changes;

      result.reviews = db.prepare(`
        DELETE FROM reviews WHERE agent_id IN (${agentPh}) OR reviewer_id IN (${agentPh})
      `).run(...agentIds, ...agentIds).changes;

      result.webhooks = db.prepare(`
        DELETE FROM webhooks WHERE agent_id IN (${agentPh})
      `).run(...agentIds).changes;

      result.buybackLocks = db.prepare(`
        DELETE FROM buyback_locks WHERE agent_id IN (${agentPh})
      `).run(...agentIds).changes;

      result.challenges = db.prepare(`
        DELETE FROM challenges WHERE agent_id IN (${agentPh})
      `).run(...agentIds).changes;

      result.agents = db.prepare(`
        DELETE FROM agents WHERE agent_id IN (${agentPh})
      `).run(...agentIds).changes;
    } else {
      result.agentCapabilities = 0;
      result.agentMetrics = 0;
      result.agentBudgets = 0;
      result.reviews = 0;
      result.webhooks = 0;
      result.buybackLocks = 0;
      result.challenges = 0;
      result.agents = 0;
      result.auditEventsAgents = 0;
    }

    return result;
  })();

  if (agentIds.length === 0 && counts.mppChannels === 0 && counts.mppDeposits === 0) {
    console.log("No demo/smoke agents or mock payment channels found.");
    return;
  }

  console.log(JSON.stringify({
    deletedAgents: agentIds,
    counts,
  }, null, 2));
}

main();
