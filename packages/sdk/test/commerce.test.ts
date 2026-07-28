// Agent checkout, from the owner's side.
//
// The centre of gravity here is refusing to sign. A signature over a purchase is
// non-repudiable, so the tests that matter most are the ones proving nothing gets
// signed when the purchase isn't what the caller said it was.

import { describe, it, expect, vi } from "vitest";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  CommerceApi,
  CommerceRefusedError,
  parseAuthorisation,
  assertAuthorisationMatches,
} from "../src/commerce";
import { mandateSigner } from "../src/node";
import { walletMandateSigner } from "../src/solana";

const EXPIRES = new Date(Date.now() + 3_600_000).toISOString();

function message(over: Partial<Record<string, string>> = {}): string {
  return [
    "Axon purchase authorisation",
    `intent: ${over.intent ?? "pi_1"}`,
    `business: ${over.business ?? "shop.example"}`,
    `items: ${over.items ?? "9f2c"}`,
    `amount: ${over.amount ?? "128.00 USD"}`,
    `ceiling: ${over.ceiling ?? "150.00 USD"}`,
    `expires: ${over.expires ?? EXPIRES}`,
  ].join("\n");
}

describe("parseAuthorisation", () => {
  it("reads every field the server will verify", () => {
    expect(parseAuthorisation(message())).toEqual({
      intentId: "pi_1",
      business: "shop.example",
      itemsHash: "9f2c",
      amount: 128,
      currency: "USD",
      ceiling: 150,
      expiresAt: EXPIRES,
    });
  });

  it("refuses a message it doesn't recognise rather than signing it blind", () => {
    expect(() => parseAuthorisation("please sign this\nintent: pi_1")).toThrow(/not an Axon purchase authorisation/);
    expect(() => parseAuthorisation(message().replace(/amount: .*/, "amount: lots"))).toThrow(
      /could not read the amount/,
    );
    // A missing field is caught by the shape check before anything is read.
    expect(() => parseAuthorisation(message().split("\n").filter((l) => !l.startsWith("business")).join("\n"))).toThrow(
      /5 fields, expected 6/,
    );
  });
});

describe("assertAuthorisationMatches", () => {
  const auth = parseAuthorisation(message());

  it("passes when the purchase is what you expected", () => {
    expect(() =>
      assertAuthorisationMatches(auth, { maxAmount: 150, currency: "USD", business: "shop.example" }),
    ).not.toThrow();
  });

  it("refuses a re-price into another currency instead of comparing the numbers", () => {
    const eur = parseAuthorisation(message({ amount: "120.00 EUR", ceiling: "150.00 EUR" }));
    // 120 < 150, so a bare numeric check would wave this through.
    expect(() => assertAuthorisationMatches(eur, { maxAmount: 150, currency: "USD" })).toThrow(
      CommerceRefusedError,
    );
    try {
      assertAuthorisationMatches(eur, { maxAmount: 150, currency: "USD" });
    } catch (err) {
      expect((err as CommerceRefusedError).reason).toBe("CURRENCY_MISMATCH");
    }
  });

  it("refuses an amount above what was expected", () => {
    expect(() => assertAuthorisationMatches(auth, { maxAmount: 100 })).toThrow(/above the 100.00 you expected/);
  });

  it("refuses a business that isn't on the list", () => {
    expect(() => assertAuthorisationMatches(auth, { business: ["other.example"] })).toThrow(/not one you expected/);
    expect(() => assertAuthorisationMatches(auth, { business: ["SHOP.EXAMPLE"] })).not.toThrow();
  });

  it("refuses an authorisation that already expired", () => {
    const stale = parseAuthorisation(message({ expires: new Date(Date.now() - 1000).toISOString() }));
    expect(() => assertAuthorisationMatches(stale, {})).toThrow(/already expired/);
  });
});

describe("approve()", () => {
  it("signs the server's own message and sends it", async () => {
    const sign = vi.fn(() => "SIG");
    const request = vi.fn(async (method: string, path: string) => {
      if (method === "GET") return { intentId: "pi_1", message: message(), wallet: "W", expiresAt: EXPIRES };
      return { intentId: "pi_1", status: "purchased", orderId: "o_1", settledAmount: 128 };
    });
    const { api } = withServer(request);

    const res = await api.approve("pi_1", {
      sign,
      expect: { maxAmount: 150, currency: "USD", business: "shop.example" },
      paymentInstrument: { id: "i", handlerId: "h", type: "card", credential: {} },
    });

    expect(sign).toHaveBeenCalledWith(message());
    expect(res.orderId).toBe("o_1");
    expect(res.authorisation?.amount).toBe(128);
    const post = request.mock.calls.find((c) => c[0] === "POST")!;
    expect((post[2] as { body: { signature: string } }).body.signature).toBe("SIG");
  });

  it("does not sign — or call the server — when the purchase moved", async () => {
    const sign = vi.fn();
    const request = vi.fn(async () => ({ intentId: "pi_1", message: message({ amount: "900.00 USD" }), wallet: "W", expiresAt: EXPIRES }));
    const { api } = withServer(request);

    await expect(api.approve("pi_1", { sign, expect: { maxAmount: 150 } })).rejects.toThrow(
      CommerceRefusedError,
    );
    expect(sign).not.toHaveBeenCalled();
    expect(request.mock.calls.every((c) => c[0] === "GET")).toBe(true);
  });

  it("refuses an authorisation addressed to a different purchase", async () => {
    const sign = vi.fn();
    const request = vi.fn(async () => ({ intentId: "pi_2", message: message({ intent: "pi_2" }), wallet: "W", expiresAt: EXPIRES }));
    const { api } = withServer(request);
    await expect(api.approve("pi_1", { sign })).rejects.toThrow(/is for pi_2, not pi_1/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("insists on a signer — approving is signing", async () => {
    const { api } = withServer(vi.fn());
    await expect(api.approve("pi_1", {})).rejects.toThrow(/approving is signing/);
    await expect(api.approve("pi_1", { sign: () => "s", signature: "s" })).rejects.toThrow(/not both/);
  });

  it("reports an approval with no payment credential as awaiting payment, not as bought", async () => {
    const request = vi.fn(async (method: string) =>
      method === "GET"
        ? { intentId: "pi_1", message: message(), wallet: "W", expiresAt: EXPIRES }
        : { intentId: "pi_1", status: "approved", reason: "NO_PAYMENT_INSTRUMENT" },
    );
    const { api } = withServer(request);
    const res = await api.approve("pi_1", { sign: () => "SIG" });
    expect(res.awaitingPayment).toBe(true);
    expect(res.orderId).toBeUndefined();
  });
});

describe("autoApprove()", () => {
  it("refuses to exist without every bound — an open bound is a blank cheque", () => {
    const { api } = withServer(vi.fn());
    const base = { maxAmount: 50, allowedHosts: ["shop.example"], currency: "USD", sign: () => "s" };
    expect(() => api.autoApprove({ ...base, maxAmount: 0 })).toThrow(/positive maxAmount/);
    expect(() => api.autoApprove({ ...base, allowedHosts: [] })).toThrow(/allowedHosts/);
    expect(() => api.autoApprove({ ...base, currency: "" })).toThrow(/currency/);
    expect(() => api.autoApprove({ ...base, sign: undefined as never })).toThrow(/signer/);
  });

  it("leaves a purchase outside the policy alone rather than declining it", async () => {
    const skipped: string[] = [];
    const sign = vi.fn(() => "SIG");
    const request = vi.fn(async (method: string, path: string) => {
      if (path.startsWith("/api/commerce/intents?")) {
        return { intents: [{ intentId: "pi_1", status: "proposed", businessHost: "shop.example" }], summary: {} };
      }
      return { intentId: "pi_1", message: message({ amount: "900.00 USD" }), wallet: "W", expiresAt: EXPIRES };
    });
    const { api } = withServer(request);

    const handle = api.autoApprove({
      maxAmount: 50,
      allowedHosts: ["shop.example"],
      currency: "USD",
      sign,
      onSkipped: (_i, reason) => void skipped.push(reason),
    });
    await vi.waitFor(() => expect(skipped).toContain("OVER_EXPECTED_AMOUNT"));
    handle.stop();

    expect(sign).not.toHaveBeenCalled();
    // Never posts a decision for something it refused.
    expect(request.mock.calls.every((c) => c[0] === "GET")).toBe(true);
  });
});

describe("watch()", () => {
  it("hands over each purchase once", async () => {
    const seen: string[] = [];
    const request = vi.fn(async () => ({
      intents: [{ intentId: "pi_1", status: "proposed" }, { intentId: "pi_2", status: "proposed" }],
      summary: {},
    }));
    const { api } = withServer(request);
    const handle = api.watch({ onProposed: (i) => void seen.push(i.intentId), intervalMs: 1_000 });
    await vi.waitFor(() => expect(seen).toEqual(["pi_1", "pi_2"]));
    // A second poll must not re-deliver them.
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(["pi_1", "pi_2"]);
    handle.stop();
  });
});

describe("mandateSigner", () => {
  it("produces a signature Axon's own verifier accepts", () => {
    // This is the interop that matters: Axon verifies with
    // nacl.sign.detached.verify against the buyer's wallet bytes. If this
    // round-trip fails, every approval made from Node fails.
    const keypair = Keypair.generate();
    const msg = message();
    const sig = mandateSigner(keypair)(msg) as string;

    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(msg),
      Buffer.from(sig, "base64"),
      keypair.publicKey.toBytes(),
    );
    expect(ok).toBe(true);
  });

  it("does not vouch for a message it didn't sign", () => {
    const keypair = Keypair.generate();
    const sig = mandateSigner(keypair)(message()) as string;
    const tampered = message({ amount: "900.00 USD" });
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(tampered),
      Buffer.from(sig, "base64"),
      keypair.publicKey.toBytes(),
    );
    expect(ok).toBe(false);
  });

  it("accepts a raw secret key as well as a Keypair", () => {
    const keypair = Keypair.generate();
    const sig = mandateSigner(keypair.secretKey)(message()) as string;
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(message()),
        Buffer.from(sig, "base64"),
        keypair.publicKey.toBytes(),
      ),
    ).toBe(true);
  });
});

// Small helper so each test reads as "given this server, ...".
function withServer(request: ReturnType<typeof vi.fn>) {
  return { api: new CommerceApi(request as never), request };
}

// ── What the second pass found ────────────────────────────────────────────────

describe("a refusal is a refusal, whoever made it", () => {
  it("presents a server-side refusal as CommerceRefusedError, not a bare API error", async () => {
    // The re-checks at the charge — price moved, currency changed, budget
    // committed — all come back this way. A caller branching on
    // CommerceRefusedError must not silently miss them.
    const apiErr = Object.assign(new Error("HTTP 502"), {
      name: "AxonApiError",
      body: { reason: "CURRENCY_CHANGED", purchaseError: "The business is now pricing in EUR." },
    });
    const request = vi.fn(async (method: string) => {
      if (method === "GET") return { intentId: "pi_1", message: message(), wallet: "W", expiresAt: EXPIRES };
      throw apiErr;
    });
    const { api } = withServer(request);

    await expect(api.approve("pi_1", { sign: () => "SIG" })).rejects.toThrow(CommerceRefusedError);
    try {
      await api.approve("pi_1", { sign: () => "SIG" });
    } catch (err) {
      expect((err as CommerceRefusedError).reason).toBe("CURRENCY_CHANGED");
      expect((err as CommerceRefusedError).intentId).toBe("pi_1");
      expect((err as Error).message).toMatch(/pricing in EUR/);
    }
  });

  it("also reads a reason out of an apiError's details", async () => {
    const apiErr = Object.assign(new Error("invalid signature"), {
      name: "AxonApiError",
      details: { reason: "BAD_SIGNATURE" },
    });
    const { api } = withServer(vi.fn(async () => { throw apiErr; }));
    await expect(api.listMandates()).rejects.toMatchObject({ name: "CommerceRefusedError", reason: "BAD_SIGNATURE" });
  });

  it("leaves an ordinary failure alone", async () => {
    const boom = Object.assign(new Error("network down"), { name: "AxonApiError" });
    const { api } = withServer(vi.fn(async () => { throw boom; }));
    await expect(api.listProfiles()).rejects.toThrow("network down");
    await expect(api.listProfiles()).rejects.not.toBeInstanceOf(CommerceRefusedError);
  });
});

describe("the parser is the security boundary", () => {
  it("refuses a duplicated field instead of taking the first one", () => {
    // Take the first match and an injected line shadows the real amount, so a
    // signature the buyer thinks covers 1.00 actually covers 4999.00.
    const shadowed = [
      "Axon purchase authorisation",
      "intent: pi_1",
      "business: shop.example",
      "items: 9f",
      "amount: 1.00 USD",
      "amount: 4999.00 USD",
      "ceiling: 5000.00 USD",
      `expires: ${EXPIRES}`,
    ].join("\n");
    expect(() => parseAuthorisation(shadowed)).toThrow(/7 fields, expected 6/);
  });

  it("refuses fields that arrive out of order", () => {
    const swapped = [
      "Axon purchase authorisation",
      "business: shop.example",
      "intent: pi_1",
      "items: 9f",
      "amount: 128.00 USD",
      "ceiling: 150.00 USD",
      `expires: ${EXPIRES}`,
    ].join("\n");
    expect(() => parseAuthorisation(swapped)).toThrow(/expected 'intent' at line 2/);
  });

  it("refuses trailing junk after an amount", () => {
    expect(() => parseAuthorisation(message({ amount: "128.00 USD and a pony" }))).toThrow(
      /could not read the amount/,
    );
  });

  it("refuses an unreadable expiry rather than treating it as far future", () => {
    expect(() => parseAuthorisation(message({ expires: "whenever" }))).toThrow(/no readable expiry/);
  });
});

describe("a watcher has to survive its own callbacks", () => {
  it("does not let a throwing onProposed escape into the interval", async () => {
    const errors: unknown[] = [];
    const request = vi.fn(async () => ({
      intents: [{ intentId: "pi_1", status: "proposed" }],
      summary: {},
    }));
    const { api } = withServer(request);
    const handle = api.watch({
      onProposed: () => { throw new Error("notify() failed"); },
      onError: (e) => void errors.push(e),
      intervalMs: 1_000,
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    handle.stop();
    expect((errors[0] as Error).message).toBe("notify() failed");
  });

  it("forgets intents that are no longer pending, so it doesn't grow forever", async () => {
    const seenIds: string[] = [];
    let poll = 0;
    const request = vi.fn(async () => {
      poll += 1;
      // pi_1 is decided after the first poll; pi_2 shows up later.
      return poll === 1
        ? { intents: [{ intentId: "pi_1", status: "proposed" }], summary: {} }
        : { intents: [{ intentId: "pi_2", status: "proposed" }], summary: {} };
    });
    const { api } = withServer(request);
    const handle = api.watch({ onProposed: (i) => void seenIds.push(i.intentId), intervalMs: 1_000 });
    await vi.waitFor(() => expect(seenIds).toEqual(["pi_1"]));
    await (api as unknown as { pending(): Promise<unknown> }).pending(); // let poll advance
    handle.stop();
    expect(seenIds).toEqual(["pi_1"]);
  });
});

describe("nothing waiting should ever be invisible", () => {
  it("asks for the largest page when listing what's pending", async () => {
    const request = vi.fn(async () => ({ intents: [], summary: {} }));
    const { api } = withServer(request);
    await api.pending();
    // Not the server's default page — a purchase behind newer decided ones is
    // one the owner is never shown, and never approves.
    expect(request.mock.calls[0][1]).toContain("limit=200");
    expect(request.mock.calls[0][1]).toContain("status=proposed");
  });
});

describe("walletMandateSigner", () => {
  it("base64s whatever shape the wallet returns", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expected = Buffer.from(bytes).toString("base64");
    // Phantom returns { signature }; some wallets return the bytes directly.
    expect(await walletMandateSigner({ signMessage: async () => ({ signature: bytes }) })("m")).toBe(expected);
    expect(await walletMandateSigner({ signMessage: async () => bytes })("m")).toBe(expected);
  });

  it("connects first when the wallet needs it", async () => {
    const connect = vi.fn(async () => {});
    await walletMandateSigner({ connect, signMessage: async () => new Uint8Array([1]) })("m");
    expect(connect).toHaveBeenCalled();
  });
});

describe("mandateSigner rejects a key it can't use", () => {
  it("refuses a 32-byte seed rather than signing with the wrong bytes", () => {
    expect(() => mandateSigner(new Uint8Array(32))).toThrow(/64-byte/);
  });
});

// ── What the third pass found ─────────────────────────────────────────────────

describe("an expectation is a constraint on every path, not one", () => {
  it("enforces expect when the caller signed the message elsewhere", async () => {
    // Hardware wallets, remote signers and custody services all produce the
    // signature out of band and pass it in. They state the same bounds as
    // anyone else, and an expect that only bites when the SDK holds the key
    // reads as a limit while enforcing nothing.
    let posted = false;
    const request = vi.fn(async (method: string) => {
      if (method === "GET") return { intentId: "pi_1", message: message({ amount: "4999.00 USD" }), wallet: "W", expiresAt: EXPIRES };
      posted = true;
      return { intentId: "pi_1", status: "purchased", orderId: "o_1" };
    });
    const { api } = withServer(request);

    await expect(
      api.approve("pi_1", { signature: "SIGNED_ELSEWHERE", expect: { maxAmount: 150, currency: "USD" } }),
    ).rejects.toMatchObject({ name: "CommerceRefusedError", reason: "OVER_EXPECTED_AMOUNT" });
    expect(posted).toBe(false);
  });

  it("still approves an out-of-band signature that matches", async () => {
    const request = vi.fn(async (method: string) =>
      method === "GET"
        ? { intentId: "pi_1", message: message(), wallet: "W", expiresAt: EXPIRES }
        : { intentId: "pi_1", status: "purchased", orderId: "o_1" },
    );
    const { api } = withServer(request);
    const res = await api.approve("pi_1", { signature: "SIG", expect: { maxAmount: 150, currency: "USD" } });
    expect(res.orderId).toBe("o_1");
    expect(res.authorisation?.amount).toBe(128);
  });

  it("does not fetch anything when there is nothing to check and nothing to sign", async () => {
    const request = vi.fn(async () => ({ intentId: "pi_1", status: "purchased", orderId: "o_1" }));
    const { api } = withServer(request);
    await api.approve("pi_1", { signature: "SIG" });
    expect(request.mock.calls.every((c) => c[0] === "POST")).toBe(true);
  });
});

describe("a bad minute shouldn't cost a purchase", () => {
  it("retries a purchase whose handler failed, instead of dropping it", async () => {
    let attempts = 0;
    const request = vi.fn(async () => ({ intents: [{ intentId: "pi_1", status: "proposed" }], summary: {} }));
    const { api } = withServer(request);
    const handle = api.watch({
      intervalMs: 1_000,
      onError: () => {},
      onProposed: () => {
        attempts += 1;
        if (attempts < 2) throw new Error("upstream hiccup");
      },
    });
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2), { timeout: 4_000 });
    handle.stop();
  });

  it("lets a policy refusal stand — that answer will not change", async () => {
    const skipped: string[] = [];
    const request = vi.fn(async (method: string, path: string) =>
      path.startsWith("/api/commerce/intents?")
        ? { intents: [{ intentId: "pi_1", status: "proposed", businessHost: "shop.example" }], summary: {} }
        : { intentId: "pi_1", message: message({ amount: "900.00 USD" }), wallet: "W", expiresAt: EXPIRES },
    );
    const { api } = withServer(request);
    const handle = api.autoApprove({
      maxAmount: 50, currency: "USD", allowedHosts: ["shop.example"], sign: () => "SIG",
      intervalMs: 1_000,
      onSkipped: (_i, reason) => void skipped.push(reason),
    });
    await vi.waitFor(() => expect(skipped).toHaveLength(1));
    // Left alone, and not re-litigated on the next poll.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(skipped).toHaveLength(1);
    handle.stop();
  });
});

describe("acting on a webhook", () => {
  it("fetches one purchase by id, without paging through everything", async () => {
    const request = vi.fn(async () => ({ intentId: "pi_9", status: "proposed", summary: "shoes" }));
    const { api } = withServer(request);
    const intent = await api.getPurchase("pi_9");
    expect(intent.intentId).toBe("pi_9");
    expect(request.mock.calls[0][1]).toBe("/api/commerce/intents/pi_9");
  });
});

describe("a watcher that watches nothing is worse than no watcher", () => {
  it("keeps the event loop alive by default", () => {
    const request = vi.fn(async () => ({ intents: [], summary: {} }));
    const { api } = withServer(request);
    const handle = api.watch({ onProposed: () => {}, intervalMs: 60_000 });
    // A script whose whole job is watching must not exit the moment it starts.
    expect(process.getActiveResourcesInfo?.()).toContain("Timeout");
    handle.stop();
  });

  it("lets the caller opt out when something else owns the lifecycle", () => {
    const request = vi.fn(async () => ({ intents: [], summary: {} }));
    const { api } = withServer(request);
    const before = (process.getActiveResourcesInfo?.() ?? []).filter((r) => r === "Timeout").length;
    const handle = api.watch({ onProposed: () => {}, intervalMs: 60_000, keepAlive: false });
    const after = (process.getActiveResourcesInfo?.() ?? []).filter((r) => r === "Timeout").length;
    expect(after).toBe(before);
    handle.stop();
  });
})
