// The check that would have caught the three and a half week outage.
//
// A monitor like this earns its place by staying quiet. Agents fail for their own reasons all day
// and that is the network working; the thing worth waking someone for is every agent failing the
// same way at once. These cover both sides of that line.

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { failureReport, failureSignature } from "@/lib/failurePatterns";

const AUTH = '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}';
let seq = 0;

function task(status: "completed" | "failed", error: string | null, agent: string, minsAgo = 5) {
  const at = new Date(Date.now() - minsAgo * 60_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, error, completed_at, created_at)
       VALUES (?, 'someone', ?, 't', ?, ?, ?, ?)`,
    )
    .run(`fp-${++seq}`, agent, status, error, at, at);
}

beforeEach(() => getDb().prepare("DELETE FROM tasks").run());

describe("what an error actually is", () => {
  it("recognises the fault behind different wordings", () => {
    expect(failureSignature(AUTH)).toBe("provider rejected the API key");
    expect(failureSignature("429 rate_limit_error")).toBe("provider rate limit");
    expect(failureSignature("The model `gpt5.5` does not exist")).toBe("model does not exist");
    expect(failureSignature("fetch failed")).toBe("agent endpoint unreachable");
    expect(failureSignature("Request timed out after 60000ms")).toBe("timed out");
  });

  it("groups the same fault even when the text never repeats", () => {
    const a = failureSignature("Request abc-123 failed after 4210ms with 3 retries");
    const b = failureSignature("Request def-999 failed after 8817ms with 9 retries");
    expect(a).toBe(b);
  });
});

describe("the systemic failure check", () => {
  it("stays quiet when there is barely anything to judge", () => {
    task("failed", AUTH, "a");
    task("failed", AUTH, "b");
    expect(failureReport().ok).toBe(true);
  });

  it("stays quiet when agents fail for their own separate reasons", () => {
    for (let i = 0; i < 6; i++) task("failed", "The model `gpt5.5` does not exist", "wert");
    for (let i = 0; i < 5; i++) task("failed", "429 rate_limit_error", `agent-${i}`);
    for (let i = 0; i < 5; i++) task("failed", "Request timed out after 60000ms", `other-${i}`);
    for (let i = 0; i < 40; i++) task("completed", null, `agent-${i}`);
    expect(failureReport().ok).toBe(true);
  });

  it("stays quiet when one broken agent fails a lot, because that is one agent", () => {
    for (let i = 0; i < 30; i++) task("failed", "The model `gpt5.5` does not exist", "wert");
    const r = failureReport();
    expect(r.ok).toBe(true); // dominant, but a single agent: not the platform
  });

  it("catches the outage that ran for three and a half weeks", () => {
    // every agent failing the same way, which is what an invalid platform key looks like
    for (let i = 0; i < 40; i++) task("failed", AUTH, `agent-${i % 12}`);
    for (let i = 0; i < 3; i++) task("completed", null, "agent-1");

    const r = failureReport();

    expect(r.ok).toBe(false);
    expect(r.alert).toContain("provider rejected the API key");
    expect(r.alert).toContain("That is the platform, not the agents");
    expect(r.patterns[0].signature).toBe("provider rejected the API key");
    expect(r.patterns[0].agentsAffected).toBe(12);
  });

  it("ignores failures older than the window, so a fixed outage stops shouting", () => {
    for (let i = 0; i < 40; i++) task("failed", AUTH, `agent-${i % 12}`, 60 * 24); // a day ago
    expect(failureReport().ok).toBe(true);
  });
});
