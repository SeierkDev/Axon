// The Proof Score breakdown ("show the math") — rendered to static markup so its
// real output is exercised: the exact component computation, the recomputable
// inputs, and the native settled receipts the score is built from.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScoreMath } from "@/app/agents/[agentId]/ProofScoreCard";
import type { ProofScore } from "@/lib/proofScore";

function proof(over?: Partial<ProofScore>): ProofScore {
  return {
    agentId: "a",
    name: "A",
    score: 978,
    tier: "Elite",
    inputs: {
      reputation: 8.2,
      tasksCompleted: 40,
      tasksFailed: 2,
      successRate: 0.95,
      paymentReliability: 1,
      avgResponseSec: 3,
      settledUsdc: 120,
      staleDays: null,
      decayFactor: 1,
    },
    // 594 + 383.6 = 977.6, which the formula ROUNDS to 978 — the reconciliation case.
    components: {
      quality: { factor: 0.99, weight: 0.6, points: 594 },
      provenWork: { factor: 0.959, weight: 0.4, points: 383.6 },
    },
    evidence: [
      { taskId: "t1", network: "axon", receipt: "/r/t1", verify: "/api/receipts/t1/trace", completedAt: "2026-07-10T00:00:00.000Z", settledUsdc: 0.15 },
      { taskId: "x1", network: "agenc", receipt: "https://agenc.example/x1", verify: null, completedAt: "2026-07-09T00:00:00.000Z", settledUsdc: 0.2 },
    ],
    evidenceCount: 40,
    method: {
      version: "proof-score-v1",
      scale: 1000,
      weights: { quality: 0.6, provenWork: 0.4 },
      anchors: { tasks: 30, usdc: 200 },
      formula: "score = …",
      howToVerify: "refetch receipts …",
    },
    contentHash: "abc123",
    generatedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("ScoreMath — the recompute-it-yourself breakdown", () => {
  it("shows the exact component computation and the total (factor × weight·scale = points)", () => {
    const html = renderToStaticMarkup(<ScoreMath proof={proof()} />);
    // quality: 0.99 × 600 = 594
    for (const s of ["0.99", "600", "594"]) expect(html).toContain(s);
    // proven work: 0.959 × 400 = 383.6
    for (const s of ["0.959", "400", "383.6"]) expect(html).toContain(s);
    // and the final score
    expect(html).toContain("978");
  });

  it("makes the round-to-score step visible so a hand recompute reconciles", () => {
    // 594 + 383.6 = 977.6 → 978: the Sum and a "rounded" marker must both show
    const html = renderToStaticMarkup(<ScoreMath proof={proof()} />);
    expect(html).toContain("977.6"); // the pre-round sum is shown
    expect(html).toContain("(rounded)"); // and the score is flagged as rounded

    // when the components already sum to a whole score, no Sum row / no "(rounded)"
    const whole = renderToStaticMarkup(
      <ScoreMath proof={proof({ score: 798, components: { quality: { factor: 0.99, weight: 0.6, points: 594 }, provenWork: { factor: 0.51, weight: 0.4, points: 204 } } })} />,
    );
    expect(whole).not.toContain("(rounded)");
    expect(whole).toContain("798");
  });

  it("shows the recomputable inputs", () => {
    const html = renderToStaticMarkup(<ScoreMath proof={proof()} />);
    expect(html).toContain("8.2 / 10"); // reputation
    expect(html).toContain("120 USDC"); // settled value
    expect(html).toContain("95%"); // success rate
    expect(html).toContain("100%"); // payment reliability
  });

  it("lists only the NATIVE settled receipts, each linking to its /r/ page", () => {
    const html = renderToStaticMarkup(<ScoreMath proof={proof()} />);
    expect(html).toContain('href="/r/t1"'); // native, shown
    expect(html).not.toContain("agenc.example"); // cross-network belongs to the other section, not here
    expect(html).toContain("1 of 40"); // 1 native shown of 40 total settled
  });
});
