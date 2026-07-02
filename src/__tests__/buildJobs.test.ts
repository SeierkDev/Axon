// Tests for the durable Build job store (build_jobs, migration 038) — the
// persistence that lets a server restart auto-resume paid builds instead of
// asking the customer to click Resume.

import { describe, it, expect } from "vitest";
import {
  createBuildJob,
  getBuildJob,
  getBuildJobBySignature,
  getUnfinishedBuildJobs,
  setBuildStep,
  finishBuildJob,
  failBuildJob,
  JOB_TTL_MS,
} from "@/lib/buildJobs";
import { getDb } from "@/lib/db";

let n = 0;
const id = () => `build-job-test-${++n}-${Math.random().toString(36).slice(2)}`;

describe("createBuildJob / getBuildJob", () => {
  it("persists and reads back a fresh job", () => {
    const buildId = id();
    createBuildJob(buildId, "sig-a", "a frog game");
    const job = getBuildJob(buildId);
    expect(job).toBeDefined();
    expect(job!.signature).toBe("sig-a");
    expect(job!.prompt).toBe("a frog game");
    expect(job!.done).toBe(false);
    expect(job!.error).toBeNull();
    expect(job!.steps).toEqual({});
  });

  it("returns undefined for an unknown buildId", () => {
    expect(getBuildJob("no-such-build")).toBeUndefined();
  });
});

describe("setBuildStep", () => {
  it("updates per-agent progress across separate reads (survives 'restarts')", () => {
    const buildId = id();
    createBuildJob(buildId, "sig-b", "p");
    setBuildStep(buildId, "build-coder", "running", 2);
    setBuildStep(buildId, "build-qa", "done", 1, true);
    // Read through a fresh query — nothing held in memory.
    const job = getBuildJob(buildId)!;
    expect(job.steps["build-coder"]).toEqual({ status: "running", attempt: 2, passed: undefined });
    expect(job.steps["build-qa"]).toEqual({ status: "done", attempt: 1, passed: true });
  });
});

describe("finishBuildJob / failBuildJob", () => {
  it("marks a job done with html on finish", () => {
    const buildId = id();
    createBuildJob(buildId, "sig-c", "p");
    finishBuildJob(buildId, "<html>game</html>", true);
    const job = getBuildJob(buildId)!;
    expect(job.done).toBe(true);
    expect(job.passed).toBe(true);
    expect(job.html).toBe("<html>game</html>");
  });

  it("marks a job done with an error on failure", () => {
    const buildId = id();
    createBuildJob(buildId, "sig-d", "p");
    failBuildJob(buildId, "boom");
    const job = getBuildJob(buildId)!;
    expect(job.done).toBe(true);
    expect(job.error).toBe("boom");
  });
});

describe("getBuildJobBySignature", () => {
  it("returns the most recent job for a payment", () => {
    const sig = `sig-multi-${id()}`;
    const first = id();
    const second = id();
    createBuildJob(first, sig, "p1");
    createBuildJob(second, sig, "p2");
    // Make the second strictly newer.
    getDb().prepare(`UPDATE build_jobs SET updated_at = updated_at + 10 WHERE build_id = ?`).run(second);
    expect(getBuildJobBySignature(sig)!.buildId).toBe(second);
  });

  it("returns undefined for an empty signature", () => {
    expect(getBuildJobBySignature("")).toBeUndefined();
  });
});

describe("getUnfinishedBuildJobs", () => {
  it("returns only unfinished jobs, oldest first", () => {
    const a = id();
    const b = id();
    const c = id();
    createBuildJob(a, "sig-u1", "pa");
    createBuildJob(b, "sig-u2", "pb");
    createBuildJob(c, "sig-u3", "pc");
    finishBuildJob(c, "<html/>", true);
    getDb().prepare(`UPDATE build_jobs SET updated_at = updated_at - 100 WHERE build_id = ?`).run(b);

    const unfinished = getUnfinishedBuildJobs().map((j) => j.buildId);
    expect(unfinished).toContain(a);
    expect(unfinished).toContain(b);
    expect(unfinished).not.toContain(c);
    expect(unfinished.indexOf(b)).toBeLessThan(unfinished.indexOf(a));
  });
});

describe("prune on create", () => {
  it("removes finished jobs past the TTL but keeps unfinished ones", () => {
    const old = id();
    const oldUnfinished = id();
    createBuildJob(old, "sig-old", "p");
    finishBuildJob(old, "<html/>", true);
    createBuildJob(oldUnfinished, "sig-old-2", "p");
    const past = Date.now() - JOB_TTL_MS - 1000;
    getDb().prepare(`UPDATE build_jobs SET updated_at = ? WHERE build_id IN (?, ?)`).run(past, old, oldUnfinished);

    createBuildJob(id(), "sig-fresh", "p"); // triggers prune
    expect(getBuildJob(old)).toBeUndefined();
    // Unfinished jobs are never pruned here — boot resume decides their fate.
    expect(getBuildJob(oldUnfinished)).toBeDefined();
  });
});
