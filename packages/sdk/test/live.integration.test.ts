// The SDK against a real Axon server.
//
// Everything else in this folder runs against stubs, which is right for logic and useless for the
// thing that actually broke: the SDK and the server disagreeing about a payload. Paying in $AXON
// failed for three separate reasons at once, and every one of them would have passed a mocked test,
// because a mock answers with whatever the test author believed the server sends.
//
// So these talk to a server. They are skipped unless AXON_E2E_URL points at one, which keeps a
// normal `npm test` fast and offline. Run them with:
//
//   node scripts/sdk-e2e.mjs
//
// which boots a server on a scratch database, mints a key, and runs this file against it.
//
// Nothing here spends money. The paying tests use transactions that do not exist, so what is under
// test is the refusal and what it leaves behind, which is the half that has to be right anyway.

import { describe, it, expect, beforeAll } from "vitest";
import { AxonClient, AxonApiError, selectPaymentOption } from "../src/index";
import type { X402Requirements } from "../src/types";

const URL = process.env.AXON_E2E_URL;
const KEY = process.env.AXON_E2E_KEY;
const OWNER = process.env.AXON_E2E_OWNER ?? "0x1111111111111111111111111111111111111111";
const AGENT = process.env.AXON_E2E_AGENT ?? "sdk-e2e-agent";

const live = URL ? describe : describe.skip;

live("the SDK against a running server", () => {
  let axon: AxonClient;

  beforeAll(() => {
    axon = new AxonClient({ endpoint: URL, apiKey: KEY });
  });

  it("reads an agent, with the fields this version added", async () => {
    const agent = await axon.getAgent("research-agent");

    expect(agent.agentId).toBe("research-agent");
    // Both arrived in the last release. If the server stopped sending them the SDK would carry a
    // type that quietly describes nothing, which is the class of bug this file exists for.
    expect(agent).toHaveProperty("acceptsAxon");
    // description is written by a model after registration, so a scratch server has none yet. What
    // matters is that when the server does send one, the SDK carries it through as a string.
    if (agent.description !== undefined) expect(typeof agent.description).toBe("string");
  });

  it("lets an owner opt into $AXON and set a discount", async () => {
    // The whole point of updateAgent. Before it existed the setting was reachable from the database
    // and the payment path and from nowhere an owner could use.
    const on = await axon.updateAgent(AGENT, { acceptsAxon: true, axonDiscountBps: 2_500 });
    expect(on.acceptsAxon).toBe(true);
    expect(on.axonDiscountBps).toBe(2_500);

    const off = await axon.updateAgent(AGENT, { acceptsAxon: false });
    expect(off.acceptsAxon).toBe(false);

    await axon.updateAgent(AGENT, { acceptsAxon: true, axonDiscountBps: 2_500 });
  });

  it("refuses a discount outside the range rather than clamping it", async () => {
    // A typo becoming a real half-price offer is worse than a rejected request.
    await expect(axon.updateAgent(AGENT, { axonDiscountBps: 50_000 })).rejects.toBeInstanceOf(AxonApiError);
  });

  it("will not let a stranger change somebody else's agent", async () => {
    const stranger = new AxonClient({ endpoint: URL, apiKey: "axon_sk_not_a_real_key" });

    await expect(stranger.updateAgent(AGENT, { acceptsAxon: false })).rejects.toBeInstanceOf(AxonApiError);
  });

  describe("the 402 an agent answers with", () => {
    let reqs: X402Requirements;

    beforeAll(async () => {
      reqs = await axon.getX402Requirements(AGENT);
    });

    it("offers ETH and $AXON once the agent has opted in", () => {
      expect(reqs.accepts.length).toBe(2);
    });

    it("pins the token amount to a quote", () => {
      const token = selectPaymentOption(reqs, "axon");

      expect(token.extra.contractAddress).toBeTruthy();
      // Without this the server cannot tell what a transfer was settling, and refuses it. Its
      // absence from the header is precisely why paying in $AXON was impossible from the SDK.
      expect(token.extra.quoteId).toBeTruthy();
      expect(BigInt(token.maxAmountRequired)).toBeGreaterThan(0n);
    });

    it("still pays in ETH unless the token is asked for", () => {
      expect(selectPaymentOption(reqs).asset).toBe("ETH");
      expect(selectPaymentOption(reqs, "axon").asset).not.toBe("ETH");
    });

    it("charges less in $AXON than the same job priced at full rate", async () => {
      // A discount that only exists in the badge would be the site lying on the agent's behalf.
      const full = await axon.getX402Requirements("research-agent"); // platform default, 10%
      const discounted = selectPaymentOption(reqs, "axon");
      const reference = selectPaymentOption(full, "axon");

      // Same pool, same moment, different discounts: the deeper one has to buy fewer tokens per ETH
      // of listed price. Compared as a ratio against each agent's own ETH price, since the two
      // agents are not priced the same.
      const ratio = (r: X402Requirements) => {
        const eth = BigInt(selectPaymentOption(r).maxAmountRequired);
        const axonUnits = BigInt(selectPaymentOption(r, "axon").maxAmountRequired);
        return Number(axonUnits / (eth / 1_000_000n));
      };
      expect(ratio(reqs)).toBeLessThan(ratio(full) * 0.95);
      expect(reference.extra.quoteId).not.toBe(discounted.extra.quoteId);
    });
  });

  describe("paying with a transaction that never happened", () => {
    it("is refused, and says which payment it was", async () => {
      const reqs = await axon.getX402Requirements(AGENT);
      const token = selectPaymentOption(reqs, "axon");
      const fakeTx = `0x${"de".repeat(32)}`;

      const pay = async () => ({ signature: fakeTx, from: OWNER });

      await expect(
        axon.submitTaskX402(AGENT, "a task that should never be created", pay, { payWith: "axon" }),
      ).rejects.toThrow();
      // Generous, because the server polls for the transaction before giving up on it: a node lags
      // the sender, and refusing a good payment because it had not been indexed yet would be worse
      // than waiting. A payment that never happened pays that full wait.
    }, 60_000);

    it("creates no task for the agent", async () => {
      // The refusal is only half of it. A payment that failed must leave nothing behind, or the
      // agent is owed work nobody paid for.
      const history = await axon.getTaskHistory({ agentId: AGENT, role: "recipient", limit: 50 });
      const created = history.filter((t) => t.task === "a task that should never be created");

      expect(created).toHaveLength(0);
    });
  });

  it("names a quote that is no longer valid, instead of saying payment failed", async () => {
    const reqs = await axon.getX402Requirements(AGENT);
    const token = selectPaymentOption(reqs, "axon");
    // A quote id that was never issued fails the same way an expired one does, which is the error
    // this is about: the caller has to be told to fetch a fresh price, not that money went missing.
    const stale: X402Requirements = {
      ...reqs,
      accepts: reqs.accepts.map((o) =>
        o === token ? { ...o, extra: { ...o.extra, quoteId: "00000000-0000-4000-8000-000000000000" } } : o,
      ),
    };

    const pay = async () => ({ signature: `0x${"ab".repeat(32)}`, from: OWNER });
    let thrown: unknown;
    try {
      const option = selectPaymentOption(stale, "axon");
      const res = await fetch(`${URL}/api/agents/${AGENT}/x402`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment": Buffer.from(
            JSON.stringify({
              // "exact", exactly as buildPaymentHeader sends it. Writing "x402" here is the bug
              // this suite found in the SDK, and repeating it would only test the same mistake.
              scheme: "exact",
              network: option.network,
              payload: { ...(await pay()), quoteId: option.extra.quoteId },
            }),
          ).toString("base64"),
        },
        body: JSON.stringify({ task: "never" }),
      });
      thrown = await res.text();
    } catch (e) {
      thrown = e;
    }

    expect(String(thrown)).toMatch(/quote|expired|unknown/i);
  });

  it("reaches the endpoints this version added", async () => {
    // Not a deep check of each. This is about the paths being real, which a mock cannot tell you:
    // two of these had the wrong signature until they were run against a server.
    await expect(axon.listMissions()).resolves.toBeInstanceOf(Array);
    await expect(axon.listPaymentChannels(OWNER)).resolves.toBeInstanceOf(Array);
    await expect(axon.getWorkerMetrics()).resolves.toHaveProperty("worker");
    await expect(axon.getMission("definitely-not-a-run")).rejects.toBeInstanceOf(AxonApiError);
  });
});
