import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { checkEligibility, describeSplit, validDevBps, MAX_DEV_BPS } from "@/lib/agentLaunch";

// An agent's token is deployed with its dev address burned in permanently. Nobody can correct that
// afterwards, including us, so what this gate lets through matters more than what it keeps out.
//
// The gate is deliberately one thing: the agent exists and answers. An earlier version required a track
// record, which was circular — you need a record to launch, and you launch to get one — and would have meant
// only the agents already here could ever qualify.

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

let n = 0;
function makeAgent(opts: { wallet?: string | null; endpoint?: string | null; status?: string } = {}) {
  const id = `launch-test-${++n}`;
  const agent: Agent = {
    agentId: id,
    name: `Agent ${n}`,
    capabilities: ["research"],
    publicKey: `pk-${id}`,
    provider: "anthropic",
    reputation: 5,
    category: "Research",
    createdAt: new Date().toISOString(),
    endpoint: opts.endpoint === undefined ? "https://example.com/agent" : opts.endpoint ?? undefined,
    walletAddress: opts.wallet === undefined ? WALLET : opts.wallet ?? undefined,
  };
  createAgent(agent);
  if (opts.status) {
    getDb().prepare(`UPDATE agents SET verification_status = ? WHERE agent_id = ?`).run(opts.status, id);
  }
  return id;
}

beforeEach(() => { n += 1000; });

describe("who may launch an agent token", () => {
  it("lets through a brand new agent with no record at all", () => {
    const id = makeAgent();
    const r = checkEligibility(id, WALLET);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBeNull();
    // zero is a perfectly good answer, and the page shows it rather than hiding it
    expect(r.record?.tasksCompleted).toBe(0);
  });

  it("refuses an agent with no endpoint, which is a ticker rather than an agent", () => {
    const id = makeAgent({ endpoint: null });
    const r = checkEligibility(id, WALLET);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/reachable/i);
  });

  it("refuses an agent whose endpoint has stopped answering", () => {
    const id = makeAgent({ status: "unreachable" });
    const r = checkEligibility(id, WALLET);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not answering/i);
  });

  it("refuses a wallet that does not own the agent", () => {
    const id = makeAgent();
    const r = checkEligibility(id, OTHER);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not the wallet/i);
  });

  it("refuses when no wallet is connected, rather than guessing one", () => {
    const id = makeAgent();
    expect(checkEligibility(id, null).eligible).toBe(false);
  });

  it("matches the owning wallet whatever case it arrives in", () => {
    const id = makeAgent();
    expect(checkEligibility(id, WALLET.toUpperCase().replace("0X", "0x")).eligible).toBe(true);
  });

  it("refuses an agent with no wallet on file, since the dev address is permanent", () => {
    const id = makeAgent({ wallet: null });
    const r = checkEligibility(id, WALLET);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/wallet on file/i);
  });

  it("says so plainly for an agent that does not exist", () => {
    const r = checkEligibility("no-such-agent", WALLET);
    expect(r.eligible).toBe(false);
    expect(r.agent).toBeNull();
  });
});

describe("the split, as it is put in front of a signature", () => {
  it("reads as plain English with no maths for the reader to do", () => {
    expect(describeSplit(7000)).toBe(
      "70% of what this agent earns goes to its wallet, 30% buys and burns its token.",
    );
    expect(describeSplit(2500)).toBe(
      "25% of what this agent earns goes to its wallet, 75% buys and burns its token.",
    );
  });

  it("refuses a share above the floor the contract enforces", () => {
    expect(validDevBps(MAX_DEV_BPS)).toBe(true);
    expect(validDevBps(MAX_DEV_BPS + 1)).toBe(false);
    expect(validDevBps(9500)).toBe(false);
  });

  it("refuses anything that is not a whole basis point", () => {
    expect(validDevBps(70.5)).toBe(false);
    expect(validDevBps(-1)).toBe(false);
    expect(validDevBps(NaN)).toBe(false);
  });
});
