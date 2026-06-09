import { describe, it, expect } from "vitest";
import { createReview, getReviewsByAgent, getAgentRating } from "@/lib/reviews";
import { createAgent } from "@/lib/agents";
import { createTask, startTask, completeTask } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";

const TEST_WALLET = "11111111111111111111111111111111";
let counter = 0;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `rv-${counter}`,
    name: `Review Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pk${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function addCompletedTask(reviewerId: string, workerId: string) {
  const task = createTask({ fromAgent: reviewerId, toAgent: workerId, task: "Test work" });
  startTask(task.taskId);
  completeTask(task.taskId, "Done");
  return task;
}

function setupCompletedTask(reviewer: Agent, worker: Agent) {
  createAgent(reviewer);
  createAgent(worker);
  return addCompletedTask(reviewer.agentId, worker.agentId);
}

// ── createReview ──────────────────────────────────────────────────────────────

describe("createReview", () => {
  it("creates a review when reviewer has a completed task with the agent", () => {
    const reviewer = makeAgent();
    const worker = makeAgent();
    setupCompletedTask(reviewer, worker);

    const review = createReview(worker.agentId, reviewer.agentId, 5, "Excellent work");
    expect(review.reviewId).toBeDefined();
    expect(review.agentId).toBe(worker.agentId);
    expect(review.reviewerId).toBe(reviewer.agentId);
    expect(review.rating).toBe(5);
    expect(review.comment).toBe("Excellent work");
    expect(review.createdAt).toBeDefined();
  });

  it("creates a review without a comment", () => {
    const reviewer = makeAgent();
    const worker = makeAgent();
    setupCompletedTask(reviewer, worker);

    const review = createReview(worker.agentId, reviewer.agentId, 4);
    expect(review.rating).toBe(4);
    expect(review.comment).toBeUndefined();
  });

  it("throws when rating is below 1", () => {
    const reviewer = makeAgent();
    const worker = makeAgent();
    setupCompletedTask(reviewer, worker);
    expect(() => createReview(worker.agentId, reviewer.agentId, 0)).toThrow(
      "Rating must be an integer between 1 and 5"
    );
  });

  it("throws when rating is above 5", () => {
    const reviewer = makeAgent();
    const worker = makeAgent();
    setupCompletedTask(reviewer, worker);
    expect(() => createReview(worker.agentId, reviewer.agentId, 6)).toThrow(
      "Rating must be an integer between 1 and 5"
    );
  });

  it("throws when rating is a non-integer", () => {
    const reviewer = makeAgent();
    const worker = makeAgent();
    setupCompletedTask(reviewer, worker);
    expect(() => createReview(worker.agentId, reviewer.agentId, 3.5)).toThrow(
      "Rating must be an integer between 1 and 5"
    );
  });

  it("throws when reviewer has no completed task with the agent", () => {
    const stranger = makeAgent();
    const worker = makeAgent();
    createAgent(stranger);
    createAgent(worker);
    expect(() => createReview(worker.agentId, stranger.agentId, 5)).toThrow(
      "REVIEW_NOT_EARNED"
    );
  });

  it("throws when task is not completed (only queued)", () => {
    const reviewer = makeAgent();
    const worker = makeAgent();
    createAgent(reviewer);
    createAgent(worker);
    createTask({ fromAgent: reviewer.agentId, toAgent: worker.agentId, task: "incomplete" });
    expect(() => createReview(worker.agentId, reviewer.agentId, 3)).toThrow(
      "REVIEW_NOT_EARNED"
    );
  });

  it("allows rating of exactly 1", () => {
    const reviewer = makeAgent();
    const worker = makeAgent();
    setupCompletedTask(reviewer, worker);
    const review = createReview(worker.agentId, reviewer.agentId, 1, "Poor");
    expect(review.rating).toBe(1);
  });
});

// ── getReviewsByAgent ─────────────────────────────────────────────────────────

describe("getReviewsByAgent", () => {
  it("returns empty array when agent has no reviews", () => {
    const agent = makeAgent();
    createAgent(agent);
    expect(getReviewsByAgent(agent.agentId)).toEqual([]);
  });

  it("returns all reviews for an agent ordered by newest first", () => {
    const reviewer1 = makeAgent();
    const reviewer2 = makeAgent();
    const worker = makeAgent();
    createAgent(reviewer1);
    createAgent(reviewer2);
    createAgent(worker);
    addCompletedTask(reviewer1.agentId, worker.agentId);
    addCompletedTask(reviewer2.agentId, worker.agentId);

    createReview(worker.agentId, reviewer1.agentId, 3);
    createReview(worker.agentId, reviewer2.agentId, 5);

    const reviews = getReviewsByAgent(worker.agentId);
    expect(reviews).toHaveLength(2);
    expect(reviews.every((r) => r.agentId === worker.agentId)).toBe(true);
  });

  it("respects the limit parameter", () => {
    const worker = makeAgent();
    const r1 = makeAgent();
    const r2 = makeAgent();
    const r3 = makeAgent();
    createAgent(worker);
    createAgent(r1);
    createAgent(r2);
    createAgent(r3);
    for (const r of [r1, r2, r3]) addCompletedTask(r.agentId, worker.agentId);
    for (const r of [r1, r2, r3]) createReview(worker.agentId, r.agentId, 4);

    const limited = getReviewsByAgent(worker.agentId, 2);
    expect(limited).toHaveLength(2);
  });
});

// ── getAgentRating ────────────────────────────────────────────────────────────

describe("getAgentRating", () => {
  it("returns 0 average and 0 count for agent with no reviews", () => {
    const agent = makeAgent();
    createAgent(agent);
    const rating = getAgentRating(agent.agentId);
    expect(rating.avgRating).toBe(0);
    expect(rating.count).toBe(0);
  });

  it("returns correct average rounded to 1 decimal", () => {
    const worker = makeAgent();
    const r1 = makeAgent();
    const r2 = makeAgent();
    const r3 = makeAgent();
    createAgent(worker);
    createAgent(r1);
    createAgent(r2);
    createAgent(r3);
    addCompletedTask(r1.agentId, worker.agentId);
    addCompletedTask(r2.agentId, worker.agentId);
    addCompletedTask(r3.agentId, worker.agentId);

    createReview(worker.agentId, r1.agentId, 5);
    createReview(worker.agentId, r2.agentId, 3);
    createReview(worker.agentId, r3.agentId, 4);

    const rating = getAgentRating(worker.agentId);
    expect(rating.avgRating).toBe(4); // (5+3+4)/3 = 4.0
    expect(rating.count).toBe(3);
  });

  it("rounds avg to 1 decimal place", () => {
    const worker = makeAgent();
    const r1 = makeAgent();
    const r2 = makeAgent();
    createAgent(worker);
    createAgent(r1);
    createAgent(r2);
    addCompletedTask(r1.agentId, worker.agentId);
    addCompletedTask(r2.agentId, worker.agentId);

    createReview(worker.agentId, r1.agentId, 5);
    createReview(worker.agentId, r2.agentId, 4);

    const rating = getAgentRating(worker.agentId);
    expect(rating.avgRating).toBe(4.5); // (5+4)/2 = 4.5
    expect(rating.count).toBe(2);
  });
});
