// The leaderboard gate: a finished run only ranks if the wallet holds enough $AXON.
//
// It decides who gets on a board, so the interesting cases are the ones where it could shut
// everybody out by accident: no token deployed yet, a node that will not answer, and a balance
// compared against the wrong scale.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { holdsAxon, _clearGateCache, GATE_AMOUNT } from "@/lib/arcadeGate";
import { resetRpcCircuit } from "@/lib/evm";

const TOKEN = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const HOLDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const BALANCE_SELECTOR = "0x70a08231"; // balanceOf(address)
const DECIMALS_SELECTOR = "0x313ce567"; // decimals()

/** A node answering the two reads the gate makes. */
function stubToken(opts: { balance: bigint; decimals?: number }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const data: string = body.params?.[0]?.data ?? "";
    const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
    const result = data.startsWith(DECIMALS_SELECTOR)
      ? word(BigInt(opts.decimals ?? 18))
      : data.startsWith(BALANCE_SELECTOR)
        ? word(opts.balance)
        : "0x";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const units = (whole: bigint, decimals = 18) => whole * 10n ** BigInt(decimals);

beforeEach(() => {
  _clearGateCache();
  resetRpcCircuit();
  process.env.AXON_TOKEN_ADDRESS = TOKEN;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AXON_TOKEN_ADDRESS;
  _clearGateCache();
});

describe("holdsAxon", () => {
  it("lets through a wallet holding the threshold exactly", async () => {
    stubToken({ balance: units(BigInt(GATE_AMOUNT)) });
    expect(await holdsAxon(HOLDER)).toBe(true);
  });

  it("keeps out a wallet one unit short", async () => {
    stubToken({ balance: units(BigInt(GATE_AMOUNT)) - 1n });
    expect(await holdsAxon(HOLDER)).toBe(false);
  });

  // The threshold is in whole tokens and the balance is in the token's own units. Assuming 18
  // where the token uses 6 would let a wallet with a thousandth of the requirement straight through.
  it("scales the threshold by the token's own decimals", async () => {
    stubToken({ balance: units(BigInt(GATE_AMOUNT), 6), decimals: 6 });
    expect(await holdsAxon(HOLDER)).toBe(true);

    _clearGateCache();
    vi.restoreAllMocks();
    stubToken({ balance: units(BigInt(GATE_AMOUNT), 6) - 1n, decimals: 6 });
    expect(await holdsAxon(HOLDER)).toBe(false);
  });

  it("rejects something that is not an address without calling the node", async () => {
    const spy = stubToken({ balance: units(9999n) });
    expect(await holdsAxon("not-an-address")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  // Before the launch there is no token, so there is nothing to hold. Gating on it would shut
  // every player out of the board rather than letting them all on.
  it("is open when no token is configured", async () => {
    delete process.env.AXON_TOKEN_ADDRESS;
    const spy = stubToken({ balance: 0n });
    expect(await holdsAxon(HOLDER)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  // An outage is not evidence that somebody is broke.
  it("fails open when the node will not answer, and does not cache that", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("node down"));
    expect(await holdsAxon(HOLDER)).toBe(true);

    // The outage also trips the shared circuit breaker, which is its job. Clear it so this asserts
    // the gate's own behaviour rather than the breaker's.
    vi.restoreAllMocks();
    resetRpcCircuit();
    stubToken({ balance: 0n });
    expect(await holdsAxon(HOLDER)).toBe(false); // the retry gets a real answer
  });

  it("caches a real answer rather than asking again", async () => {
    const spy = stubToken({ balance: units(BigInt(GATE_AMOUNT)) });
    expect(await holdsAxon(HOLDER)).toBe(true);
    const callsAfterFirst = spy.mock.calls.length;
    expect(await holdsAxon(HOLDER)).toBe(true);
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("treats a wallet the same whatever case it arrives in", async () => {
    stubToken({ balance: units(BigInt(GATE_AMOUNT)) });
    expect(await holdsAxon(HOLDER.toUpperCase().replace("0X", "0x"))).toBe(true);
  });
});
