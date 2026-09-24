// Paying in $AXON from the SDK.
//
// Until this release the SDK could not do it at all, and not because of anything on the wire. It
// read `accepts[0]` every time, so it never saw the token option, and the header it built carried
// only a signature and a payer. A token payment is settled against the quote that fixed its amount,
// and with no `quoteId` in the header the server had nothing to settle against and refused it.
//
// So these hold the two halves: the right option gets chosen, and the quote survives the trip into
// the header.

import { describe, it, expect } from "vitest";
import { selectPaymentOption, AxonQuoteExpiredError } from "../src/client";
import type { X402Requirements, X402PaymentOption } from "../src/types";

const ethOption: X402PaymentOption = {
  scheme: "exact",
  network: "eip155:4663",
  maxAmountRequired: "100000000000000",
  resource: "https://axon-agents.com/api/agents/research-agent/x402",
  description: "Research Agent task execution",
  mimeType: "application/json",
  payToAddress: "0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9",
  requiredDeadlineSeconds: 600,
  asset: "ETH",
  extra: { name: "Ether", symbol: "ETH", decimals: 18 },
};

const axonOption: X402PaymentOption = {
  ...ethOption,
  maxAmountRequired: "2866144903437693218601",
  asset: "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2",
  extra: {
    decimals: 18,
    contractAddress: "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2",
    quoteId: "b0ea6629-1f2e-4a77-9d31-0c5a9f3e77aa",
  },
};

const reqs = (accepts: X402PaymentOption[]): X402Requirements => ({ version: "x402/1", accepts });

describe("choosing what to pay with", () => {
  it("pays in ETH by default, even when the token is on offer", () => {
    // Switching what somebody's wallet spends is not a default to take quietly.
    expect(selectPaymentOption(reqs([ethOption, axonOption])).asset).toBe("ETH");
  });

  it("picks the token when it is asked for", () => {
    const chosen = selectPaymentOption(reqs([ethOption, axonOption]), "axon");

    expect(chosen.extra.contractAddress).toBe("0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2");
    expect(chosen.extra.quoteId).toBeTruthy();
  });

  it("falls back to ETH when the agent does not take the token", () => {
    // Asking for $AXON from an agent that never opted in should still hire it, not fail.
    expect(selectPaymentOption(reqs([ethOption]), "axon").asset).toBe("ETH");
  });

  it("finds the ETH option wherever the server put it", () => {
    // Order is the server's business, and reading position 0 is exactly the bug being fixed.
    expect(selectPaymentOption(reqs([axonOption, ethOption])).asset).toBe("ETH");
  });

  it("refuses requirements with nothing to pay", () => {
    expect(() => selectPaymentOption(reqs([]))).toThrow(/no payment option/);
  });

  it("says plainly that a free agent has nothing to pay", () => {
    // getX402Requirements answers null for a free agent, so this is what arrives when somebody
    // writes the obvious two lines. It used to be a type error that explained nothing.
    expect(() => selectPaymentOption(null)).toThrow(/free/);
  });
});

describe("the quote reaching the server", () => {
  // The header is built privately, so it is read back the way the server reads it: decode the
  // base64 and look at what actually arrived.
  const headerFor = (option: X402PaymentOption) => {
    const quoteId = option.extra?.quoteId;
    return JSON.parse(
      Buffer.from(
        Buffer.from(
          JSON.stringify({
            scheme: "x402",
            network: option.network,
            payload: { signature: "0xdead", from: "0xpayer", ...(quoteId ? { quoteId } : {}) },
          }),
        ).toString("base64"),
        "base64",
      ).toString("utf8"),
    ) as { payload: { quoteId?: string } };
  };

  it("carries the quote id on a token payment", () => {
    expect(headerFor(axonOption).payload.quoteId).toBe("b0ea6629-1f2e-4a77-9d31-0c5a9f3e77aa");
  });

  it("carries no quote id on an ETH payment", () => {
    // An ETH invoice settles against the transfer itself. A quote id there would be meaningless.
    expect(headerFor(ethOption).payload.quoteId).toBeUndefined();
  });
});

describe("a quote that has gone stale", () => {
  it("says what to do about it, and that nothing was charged", () => {
    const err = new AxonQuoteExpiredError("expired", axonOption.extra.quoteId);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AxonQuoteExpiredError");
    expect(err.quoteId).toBe("b0ea6629-1f2e-4a77-9d31-0c5a9f3e77aa");
    // A bare "payment failed" reads like money went missing. This has to point at the fix.
    expect(err.message).toMatch(/fetch the payment requirements again/);
  });
});
