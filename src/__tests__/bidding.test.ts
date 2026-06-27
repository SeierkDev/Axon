import { describe, it, expect } from "vitest";
import {
  createOpenTask,
  getOpenTaskById,
  listOpenTasks,
  submitBid,
  getBidsForOpenTask,
  acceptBid,
  revertAccept,
  cancelOpenTask,
} from "@/lib/bidding";
import { createAgent } from "@/lib/agents";
import { getTaskById } from "@/lib/tasks";
import { createWebhook, getDeliveriesByWebhook } from "@/lib/webhooks";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let counter = 0;

function makeAgent(): Agent {
  counter++;
  const a: Agent = {
    agentId: `bid-${counter}`,
    name: `Bid Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pk-${counter}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

describe("bidding", () => {
  it("creates and lists an open task", () => {
    const poster = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "Summarize x402", capabilities: ["research"] });
    expect(ot.status).toBe("open");
    expect(ot.capabilities).toEqual(["research"]);
    expect(getOpenTaskById(ot.openTaskId)?.openTaskId).toBe(ot.openTaskId);
    expect(listOpenTasks({ status: "open" }).some((t) => t.openTaskId === ot.openTaskId)).toBe(true);
  });

  it("accepts a bid and converts it into a real task at the agreed price", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "do x", capabilities: ["research"] });
    const bid = submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.05 USDC" });
    expect(bid.success).toBe(true);
    if (!bid.success) return;

    const accepted = acceptBid(ot.openTaskId, bid.bid.bidId);
    expect(accepted.success).toBe(true);
    if (!accepted.success) return;
    expect(accepted.task.fromAgent).toBe(poster.agentId);
    expect(accepted.task.toAgent).toBe(worker.agentId);
    expect(accepted.task.payment).toBe("0.05 USDC");
    expect(getTaskById(accepted.task.taskId)).not.toBeNull();
    expect(getOpenTaskById(ot.openTaskId)?.status).toBe("accepted");
    expect(getOpenTaskById(ot.openTaskId)?.acceptedTaskId).toBe(accepted.task.taskId);
  });

  it("rejects bidding on your own task", () => {
    const poster = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"] });
    const r = submitBid({ openTaskId: ot.openTaskId, agentId: poster.agentId, price: "0.05 USDC" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("FORBIDDEN");
  });

  it("rejects a second bid from the same agent", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"] });
    submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.05 USDC" });
    const dup = submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.04 USDC" });
    expect(dup.success).toBe(false);
    if (!dup.success) expect(dup.code).toBe("DUPLICATE");
  });

  it("rejects a bid over the max budget", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"], maxBudget: "0.10 USDC" });
    const r = submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.20 USDC" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("rejects a bid priced in a different currency than the max budget", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"], maxBudget: "0.10 USDC" });
    // A SOL bid must not bypass a USDC budget by being incomparable.
    const r = submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.01 SOL" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("rejects an unknown bidder agent", () => {
    const poster = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"] });
    const r = submitBid({ openTaskId: ot.openTaskId, agentId: "no-such-agent", price: "0.05 USDC" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });

  it("marks the winner accepted and the rest rejected, and closes the task", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const worker2 = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"] });
    const bid1 = submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.05 USDC" });
    const bid2 = submitBid({ openTaskId: ot.openTaskId, agentId: worker2.agentId, price: "0.06 USDC" });
    expect(bid1.success && bid2.success).toBe(true);
    if (!bid1.success || !bid2.success) return;

    expect(acceptBid(ot.openTaskId, bid1.bid.bidId).success).toBe(true);

    const bids = getBidsForOpenTask(ot.openTaskId);
    expect(bids.find((b) => b.agentId === worker.agentId)?.status).toBe("accepted");
    expect(bids.find((b) => b.agentId === worker2.agentId)?.status).toBe("rejected");

    // can't bid once accepted
    const worker3 = makeAgent();
    const late = submitBid({ openTaskId: ot.openTaskId, agentId: worker3.agentId, price: "0.01 USDC" });
    expect(late.success).toBe(false);
    if (!late.success) expect(late.code).toBe("CLOSED");

    // can't accept again
    const again = acceptBid(ot.openTaskId, bid2.bid.bidId);
    expect(again.success).toBe(false);
    if (!again.success) expect(again.code).toBe("CLOSED");
  });

  it("cancels an open task so it stops taking bids", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"] });
    expect(cancelOpenTask(ot.openTaskId)?.status).toBe("cancelled");
    const r = submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.05 USDC" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("CLOSED");
  });

  it("starts a paid bid's task in payment_pending, and revertAccept undoes the accept", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"], maxBudget: "0.10 USDC" });
    const bid = submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.05 USDC" });
    expect(bid.success).toBe(true);
    if (!bid.success) return;

    const accepted = acceptBid(ot.openTaskId, bid.bid.bidId, { initialStatus: "payment_pending" });
    expect(accepted.success).toBe(true);
    if (!accepted.success) return;
    expect(getTaskById(accepted.task.taskId)?.status).toBe("payment_pending");

    // Simulate a payment failure: revert puts everything back.
    revertAccept(ot.openTaskId, accepted.task.taskId);
    expect(getTaskById(accepted.task.taskId)).toBeNull();
    expect(getOpenTaskById(ot.openTaskId)?.status).toBe("open");
    expect(getBidsForOpenTask(ot.openTaskId).every((b) => b.status === "pending")).toBe(true);
  });

  it("emits bid.received to the poster when a bid is submitted", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const wh = createWebhook({ agentId: poster.agentId, url: "https://hook.example.com/", events: ["bid.received"] });
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"] });
    submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.05 USDC" });
    expect(getDeliveriesByWebhook(wh.webhookId).some((d) => d.eventType === "bid.received")).toBe(true);
  });

  it("emits bid.accepted to the winning agent on accept", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const wh = createWebhook({ agentId: worker.agentId, url: "https://hook2.example.com/", events: ["bid.accepted"] });
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"] });
    const bid = submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.05 USDC" });
    expect(bid.success).toBe(true);
    if (!bid.success) return;
    acceptBid(ot.openTaskId, bid.bid.bidId);
    expect(getDeliveriesByWebhook(wh.webhookId).some((d) => d.eventType === "bid.accepted")).toBe(true);
  });

  it("rejects bids after the deadline has passed", () => {
    const poster = makeAgent();
    const worker = makeAgent();
    const past = new Date(Date.now() - 60_000).toISOString();
    const ot = createOpenTask({ fromAgent: poster.agentId, task: "x", capabilities: ["research"], deadline: past });
    const r = submitBid({ openTaskId: ot.openTaskId, agentId: worker.agentId, price: "0.05 USDC" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("CLOSED");
  });

  it("lists a poster's own open tasks via the from filter", () => {
    const posterA = makeAgent();
    const posterB = makeAgent();
    const mine = createOpenTask({ fromAgent: posterA.agentId, task: "mine", capabilities: ["research"] });
    createOpenTask({ fromAgent: posterB.agentId, task: "theirs", capabilities: ["research"] });
    const results = listOpenTasks({ from: posterA.agentId });
    expect(results.some((t) => t.openTaskId === mine.openTaskId)).toBe(true);
    expect(results.every((t) => t.fromAgent === posterA.agentId)).toBe(true);
  });

  it("filters open tasks by capability", () => {
    const poster = makeAgent();
    const coding = createOpenTask({ fromAgent: poster.agentId, task: "code it", capabilities: ["coding"] });
    createOpenTask({ fromAgent: poster.agentId, task: "research it", capabilities: ["research"] });
    const results = listOpenTasks({ capability: "coding" });
    expect(results.some((t) => t.openTaskId === coding.openTaskId)).toBe(true);
    expect(results.every((t) => t.capabilities.includes("coding"))).toBe(true);
  });

  it("finds capability matches even behind newer non-matching tasks (SQL-filtered, not post-limit)", () => {
    const poster = makeAgent();
    const target = createOpenTask({ fromAgent: poster.agentId, task: "rare", capabilities: ["rare-cap"] });
    // Several newer tasks without the capability — these would fill a post-LIMIT window.
    for (let i = 0; i < 5; i++) {
      createOpenTask({ fromAgent: poster.agentId, task: `noise ${i}`, capabilities: ["research"] });
    }
    const results = listOpenTasks({ capability: "rare-cap", limit: 2 });
    expect(results.some((t) => t.openTaskId === target.openTaskId)).toBe(true);
  });
});
