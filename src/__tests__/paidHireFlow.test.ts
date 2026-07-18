// The paid hire flow (in-browser x402): an anonymous hire pays USDC on-chain,
// names the payer wallet, and the server verifies that payment (amount, currency,
// and that the named wallet signed it) before the task runs. Without a payer the
// anonymous paid lane can't verify — it's required.

// Mock payment verifier — must be set before any import that reads it.
process.env.AXON_PAYMENT_VERIFIER = "mock";

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/tasks/route";
import { GET } from "@/app/api/tasks/[taskId]/route";
import { createAgent } from "@/lib/agents";
import { startTask, completeTask } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";

// Receiver is set to this in setup.ts; the payer is a distinct valid pubkey.
const RECEIVER = "11111111111111111111111111111111";
const PAYER = "So11111111111111111111111111111111111111112";

function paidAgent(price = "0.25 USDC"): Agent {
  const a: Agent = {
    agentId: `paid-${randomUUID().slice(0, 8)}`,
    name: "Paid Hireable",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: RECEIVER,
    provider: "anthropic",
    price,
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

// mockpay:CURRENCY:UNITS:SIGNER:RECEIVER:NONCE — 0.25 USDC = 250000 units.
function mockSig(signer: string, units = 250_000) {
  return `mockpay:USDC:${units}:${signer}:${RECEIVER}:${randomUUID().slice(0, 8)}`;
}

async function postPaidHire(
  to: string,
  task: string,
  extra: Record<string, unknown>,
) {
  const req = new NextRequest("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "anonymous", to, task, ...extra }),
  });
  const res = await POST(req);
  return { res, body: (await res.json()) as { taskId?: string; claimToken?: string; error?: string } };
}

describe("paid hire flow — anonymous x402 with payerWallet", () => {
  it("verifies the payment and returns a claimToken when the payer is named", async () => {
    const a = paidAgent();
    const { res, body } = await postPaidHire(a.agentId, "audit this contract", {
      paymentSignature: mockSig(PAYER),
      payerWallet: PAYER,
    });
    expect(res.status).toBe(201);
    expect(body.taskId).toBeTruthy();
    expect(body.claimToken).toBeTruthy();

    // payment confirmed → task is runnable; worker completes it
    startTask(body.taskId!);
    completeTask(body.taskId!, "the audit result");

    const ok = await GET(
      new NextRequest(`http://localhost/api/tasks/${body.taskId}`, {
        headers: { "x-claim-token": body.claimToken! },
      }),
      { params: Promise.resolve({ taskId: body.taskId! }) },
    );
    const okBody = (await ok.json()) as { status?: string; output?: string | null };
    expect(ok.status).toBe(200);
    expect(okBody.output).toBe("the audit result");
  });

  it("rejects the paid hire when no payer is named (anonymous can't verify otherwise)", async () => {
    const a = paidAgent();
    const { res } = await postPaidHire(a.agentId, "audit this contract", {
      paymentSignature: mockSig(PAYER),
    });
    expect(res.status).toBe(402);
  });

  it("rejects a payment signed by a different wallet than the named payer", async () => {
    const a = paidAgent();
    // Payment was signed by RECEIVER, but the caller claims PAYER paid.
    const { res } = await postPaidHire(a.agentId, "audit this contract", {
      paymentSignature: mockSig(RECEIVER),
      payerWallet: PAYER,
    });
    expect(res.status).toBe(402);
  });

  it("rejects a payerWallet that isn't a valid Solana address", async () => {
    const a = paidAgent();
    const { res, body } = await postPaidHire(a.agentId, "audit this contract", {
      paymentSignature: mockSig(PAYER),
      payerWallet: "not-a-real-address",
    });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/payerWallet/i);
  });

  it("still requires a payment signature at all for paid agents", async () => {
    const a = paidAgent();
    const { res } = await postPaidHire(a.agentId, "audit this contract", { payerWallet: PAYER });
    expect(res.status).toBe(402);
  });

  it("replays a used signature to the same task WITHOUT a claimToken — spent payment recovers via receipt, not re-read", async () => {
    // This is the exact contract the in-browser recovery path relies on: a
    // second submit of an already-consumed signature returns the existing task
    // (so the UI can surface its receipt) but never mints a claimToken (the
    // signature is public on-chain — re-reading it must not hand over the
    // private output).
    const a = paidAgent();
    const sig = mockSig(PAYER);
    const first = await postPaidHire(a.agentId, "audit this contract", { paymentSignature: sig, payerWallet: PAYER });
    expect(first.res.status).toBe(201);
    expect(first.body.claimToken).toBeTruthy();

    const replay = await postPaidHire(a.agentId, "audit this contract", { paymentSignature: sig, payerWallet: PAYER });
    expect(replay.res.status).toBe(200);
    expect(replay.body.taskId).toBe(first.body.taskId); // same task — recoverable
    expect(replay.body.claimToken).toBeUndefined(); // …but the output stays private
  });
});
