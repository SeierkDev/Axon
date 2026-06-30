import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import {
  fileReport,
  listReports,
  getReportById,
  resolveReport,
  getOpenReportCount,
} from "@/lib/abuse";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";

let counter = 0;
function makeAgent(): Agent {
  counter++;
  const a: Agent = {
    agentId: `abuse-${counter}`,
    name: `Abuse Agent ${counter}`,
    capabilities: ["x"],
    publicKey: `pk-abuse-${counter}`,
    walletAddress: `owner-${counter}`,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

describe("abuse reporting & moderation", () => {
  it("files a report against an existing agent", () => {
    const target = makeAgent();
    const r = fileReport({ targetAgent: target.agentId, reporter: "wallet-1", reason: "scam", details: "took payment, no delivery" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.report.status).toBe("open");
    expect(r.report.reason).toBe("scam");
    expect(getReportById(r.report.reportId)?.targetAgent).toBe(target.agentId);
  });

  it("rejects a report against an unknown agent", () => {
    const r = fileReport({ targetAgent: "no-such-agent", reason: "spam" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });

  it("blocks an agent's owner from reporting their own agent", () => {
    const target = makeAgent();
    // The owner is identified by wallet, not agentId.
    const r = fileReport({ targetAgent: target.agentId, reporter: target.walletAddress, reason: "abuse" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("blocks a duplicate open report from the same reporter", () => {
    const target = makeAgent();
    const first = fileReport({ targetAgent: target.agentId, reporter: "reporter-x", reason: "spam" });
    expect(first.success).toBe(true);
    const dup = fileReport({ targetAgent: target.agentId, reporter: "reporter-x", reason: "scam" });
    expect(dup.success).toBe(false);
    if (!dup.success) expect(dup.code).toBe("DUPLICATE");
  });

  it("lists the queue and filters by status and target", () => {
    const a = makeAgent();
    const b = makeAgent();
    fileReport({ targetAgent: a.agentId, reason: "spam" });
    fileReport({ targetAgent: b.agentId, reason: "non_delivery" });

    expect(listReports({ targetAgent: a.agentId }).every((r) => r.targetAgent === a.agentId)).toBe(true);
    expect(listReports({ status: "open" }).every((r) => r.status === "open")).toBe(true);
  });

  it("counts open reports for an agent", () => {
    const target = makeAgent();
    fileReport({ targetAgent: target.agentId, reason: "spam" });
    fileReport({ targetAgent: target.agentId, reason: "scam" });
    expect(getOpenReportCount(target.agentId)).toBe(2);
  });

  it("resolves a report to a terminal state with a note and timestamp", () => {
    const target = makeAgent();
    const filed = fileReport({ targetAgent: target.agentId, reason: "scam" });
    expect(filed.success).toBe(true);
    if (!filed.success) return;

    const resolved = resolveReport(filed.report.reportId, "resolved", "warned the agent; restitution made");
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    expect(resolved.report.status).toBe("resolved");
    expect(resolved.report.resolution).toContain("restitution");
    expect(resolved.report.resolvedAt).toBeTruthy();
    expect(getOpenReportCount(target.agentId)).toBe(0);
  });

  it("rejects resolving an unknown report", () => {
    const r = resolveReport(randomUUID(), "dismissed");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });

  it("sanitizes a non-finite or out-of-range limit instead of throwing", () => {
    const target = makeAgent();
    for (let i = 0; i < 3; i++) fileReport({ targetAgent: target.agentId, reason: "spam" });
    expect(() => listReports({ limit: NaN })).not.toThrow();
    expect(() => listReports({ limit: Infinity })).not.toThrow();
    expect(listReports({ limit: -5 }).length).toBeLessThanOrEqual(1); // clamped to 1
    expect(listReports({ limit: 1e9 }).length).toBeLessThanOrEqual(200); // clamped to MAX
  });
});
