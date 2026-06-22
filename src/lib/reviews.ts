import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { getAgentById } from "./agents";

export interface Review {
  reviewId: string;
  agentId: string;
  reviewerId: string;
  rating: number; // 1–5
  comment?: string;
  createdAt: string;
}

export interface AgentRating {
  avgRating: number; // 1–5, 0 if no reviews
  count: number;
}

interface ReviewRow {
  review_id: string;
  agent_id: string;
  reviewer_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

function rowToReview(row: ReviewRow): Review {
  return {
    reviewId: row.review_id,
    agentId: row.agent_id,
    reviewerId: row.reviewer_id,
    rating: row.rating,
    comment: row.comment ?? undefined,
    createdAt: row.created_at,
  };
}

// Returns true if reviewerId has at least one completed task sent to agentId.
// reviewerId may be a wallet address or an agent ID — both are stored in from_agent.
function hasCompletedTaskWith(reviewerId: string, agentId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM tasks WHERE from_agent = ? AND to_agent = ? AND status = 'completed' LIMIT 1"
    )
    .get(reviewerId, agentId);
  return !!row;
}

// Phase 6 (Marketplace Trust Layer): catch the two main ways agent ratings get
// gamed before a review is written — self-reviews (an agent, or its operator's
// wallet, rating itself) and review stuffing (one reviewer padding an agent with
// repeat ratings). Returns a rejection reason, or null when the review is clean.
export function detectReviewFraud(agentId: string, reviewerId: string): string | null {
  // An agent cannot review itself.
  if (reviewerId === agentId) {
    return "SELF_REVIEW: an agent cannot review itself";
  }
  // An operator cannot review their own agent. The reviewer may be a wallet
  // directly, or one of the operator's own agents — resolve both sides to an
  // owner wallet and reject when they match (this also catches a sibling agent
  // on the same wallet being used to self-review).
  const target = getAgentById(agentId);
  if (target?.walletAddress) {
    const reviewerAgent = getAgentById(reviewerId);
    const reviewerWallet = reviewerAgent?.walletAddress ?? reviewerId;
    if (reviewerWallet === target.walletAddress) {
      return "SELF_REVIEW: an operator cannot review their own agent";
    }
  }
  // One review per reviewer per agent — block rating inflation by repeat reviews
  // (also enforced by a UNIQUE (agent_id, reviewer_id) constraint).
  const existing = getDb()
    .prepare("SELECT 1 FROM reviews WHERE agent_id = ? AND reviewer_id = ? LIMIT 1")
    .get(agentId, reviewerId);
  if (existing) {
    return "DUPLICATE_REVIEW: this reviewer has already reviewed this agent";
  }
  return null;
}

export function createReview(
  agentId: string,
  reviewerId: string,
  rating: number,
  comment?: string
): Review {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("Rating must be an integer between 1 and 5");
  }

  const fraud = detectReviewFraud(agentId, reviewerId);
  if (fraud) {
    throw new Error(fraud);
  }

  if (!hasCompletedTaskWith(reviewerId, agentId)) {
    throw new Error("REVIEW_NOT_EARNED: reviewer has no completed tasks with this agent");
  }

  const db = getDb();
  const reviewId = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO reviews (review_id, agent_id, reviewer_id, rating, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(reviewId, agentId, reviewerId, rating, comment ?? null, createdAt);

  void syncToTurso();
  return rowToReview(
    db.prepare("SELECT * FROM reviews WHERE review_id = ?").get(reviewId) as ReviewRow
  );
}

export function getReviewsByAgent(agentId: string, limit = 20): Review[] {
  const rows = getDb()
    .prepare("SELECT * FROM reviews WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(agentId, limit) as ReviewRow[];
  return rows.map(rowToReview);
}

export function getAgentRating(agentId: string): AgentRating {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS avg_rating
      FROM reviews WHERE agent_id = ?
    `)
    .get(agentId) as { count: number; avg_rating: number };

  return {
    avgRating: Math.round(row.avg_rating * 10) / 10,
    count: row.count,
  };
}
