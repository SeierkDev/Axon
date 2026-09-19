// An agent whose model the provider refuses stops being handed generated work, and comes back
// the moment it either works or its owner touches it.

import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent, updateAgent } from "@/lib/agents";
import { createTask, startTask, failTask, completeTask } from "@/lib/tasks";
import { MODEL_LOOKS_USABLE } from "@/lib/modelHealth";
import type { Agent } from "@/sdk/types";

let n = 0;
function agent(): Agent {
  const id = `mh-${++n}`;
  const a: Agent = {
    agentId: id, name: `Model Health ${id}`, capabilities: ["research"],
    publicKey: `pk-${id}`, provider: "openai", providerModel: "gpt5.5",
    reputation: 0, createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}
const flagged = (id: string) =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM agents WHERE agent_id = ? AND NOT ${MODEL_LOOKS_USABLE}`)
    .get(id) as { n: number }).n === 1;

function run(to: string, outcome: "fail" | "complete", error = "") {
  const t = createTask({ fromAgent: "someone", toAgent: to, task: "x" });
  startTask(t.taskId);
  if (outcome === "fail") failTask(t.taskId, error);
  else completeTask(t.taskId, "done");
}

describe("an unusable model takes the agent out of generated work", () => {
  it("flags the agent when the provider says the model does not exist", () => {
    const a = agent();
    expect(flagged(a.agentId)).toBe(false);

    run(a.agentId, "fail", "Provider https://api.openai.com/v1 error 404: The model `gpt5.5` does not exist or you do not have access to it.");
    expect(flagged(a.agentId)).toBe(true);
  });

  it("leaves the agent alone for an outage it had nothing to do with", () => {
    const a = agent();
    run(a.agentId, "fail", '401 {"type":"authentication_error","message":"API key is invalid."}');
    expect(flagged(a.agentId)).toBe(false);

    run(a.agentId, "fail", "Request timed out after 60000ms");
    expect(flagged(a.agentId)).toBe(false);
  });

  it("brings the agent straight back when a task actually completes", () => {
    const a = agent();
    run(a.agentId, "fail", "invalid model: gpt5.5");
    expect(flagged(a.agentId)).toBe(true);

    run(a.agentId, "complete");
    expect(flagged(a.agentId)).toBe(false);
  });

  it("brings the agent back when its owner edits it", () => {
    const a = agent();
    run(a.agentId, "fail", "model_not_found");
    expect(flagged(a.agentId)).toBe(true);

    updateAgent(a.agentId, { name: "Renamed" });
    expect(flagged(a.agentId)).toBe(false);
  });
});
