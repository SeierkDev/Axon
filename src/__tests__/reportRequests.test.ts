import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createOpenTask, listOpenTasks } from "@/lib/bidding";
import {
  requestReport,
  openReportJobs,
  MAX_OPEN_REPORTS,
  REPORT_REQUESTER,
} from "@/lib/reportRequests";

// The chain does roughly twenty thousand launches a day. If any of these limits stopped working,
// the open board would fill with write-up jobs and every human-posted task would become
// unfindable. That is the failure this file exists to prevent.

const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

beforeEach(() => {
  getDb().prepare("DELETE FROM open_tasks").run();
});

describe("asking the network to write up a token", () => {
  it("posts one job, and says an agent may take it", () => {
    const out = requestReport(TOKEN_A, "AAA");
    expect(out.status).toBe("created");
    expect(openReportJobs()).toHaveLength(1);
  });

  it("never posts a second job for the same token", () => {
    const first = requestReport(TOKEN_A, "AAA");
    const second = requestReport(TOKEN_A, "AAA");
    const third = requestReport(TOKEN_A, "AAA");

    expect(second.status).toBe("already-open");
    expect(third.status).toBe("already-open");
    if (first.status === "created" && second.status === "already-open") {
      expect(second.openTask.openTaskId).toBe(first.openTask.openTaskId);
    }
    expect(openReportJobs()).toHaveLength(1);
  });

  it("refuses past the ceiling rather than letting the board grow", () => {
    for (let i = 0; i < MAX_OPEN_REPORTS; i++) {
      const token = `0x${String(i).padStart(40, "c")}`;
      expect(requestReport(token, `T${i}`).status).toBe("created");
    }
    expect(openReportJobs()).toHaveLength(MAX_OPEN_REPORTS);

    const over = requestReport(TOKEN_B, "BBB");
    expect(over.status).toBe("at-capacity");
    expect(openReportJobs()).toHaveLength(MAX_OPEN_REPORTS);
  });

  it("does not count human-posted work against the ceiling, or crowd it", () => {
    for (let i = 0; i < 20; i++) {
      createOpenTask({ fromAgent: "some-human", task: `real work ${i}`, capabilities: ["research"] });
    }
    expect(requestReport(TOKEN_A, "AAA").status).toBe("created");
    expect(openReportJobs()).toHaveLength(1);
    expect(listOpenTasks({ from: "some-human", limit: 200 })).toHaveLength(20);
  });

  it("posts under its own identity, so these are filterable apart from real tasks", () => {
    requestReport(TOKEN_A, "AAA");
    const [job] = openReportJobs();
    expect(job.fromAgent).toBe(REPORT_REQUESTER);
    expect(job.task).toContain(`[token:${TOKEN_A}]`);
  });

  it("refuses anything that is not an address", () => {
    expect(() => requestReport("not-an-address", "X")).toThrow();
    expect(openReportJobs()).toHaveLength(0);
  });

  it("tells the agent not to reach a verdict", () => {
    requestReport(TOKEN_A, "AAA");
    const [job] = openReportJobs();
    expect(job.task).toMatch(/do not call it a scam or a good buy/i);
    expect(job.task).toMatch(/do not invent anything/i);
  });
});
