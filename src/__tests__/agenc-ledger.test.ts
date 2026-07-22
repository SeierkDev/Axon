// The Axon × AgenC Ledger adapter: mapping an Axon SOL hire onto AgenC's real
// ledger_solana_transfer_v1 contract, and the receipt back onto an Axon hire —
// plus a full route-flow check that the adapter's output settles a real hire.
process.env.AXON_PAYMENT_VERIFIER = "mock"; // must be set before importing the route

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/tasks/route";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import {
  solPriceToLamports,
  buildLedgerTransfer,
  ledgerReceiptToTask,
  type LedgerReceipt,
} from "../../examples/agenc-ledger/hireWithLedger";

// The receiver set in tests (NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS).
const RECEIVER = "11111111111111111111111111111111";

describe("AgenC Ledger adapter", () => {
  it("converts a SOL price to lamports (base-10 integer, no floats)", () => {
    expect(solPriceToLamports("0.05 SOL")).toBe(50_000_000);
    expect(solPriceToLamports("1 SOL")).toBe(1_000_000_000);
    expect(solPriceToLamports("0.123456789 SOL")).toBe(123_456_789);
  });

  it("rejects non-SOL prices — the Ledger v1 signs native SOL only", () => {
    expect(() => solPriceToLamports("5 USDC")).toThrow(/not a SOL price/i);
    expect(() => solPriceToLamports("free")).toThrow(/not a SOL price/i);
  });

  it("rejects a zero amount — a hire can't draft a zero-value transfer", () => {
    expect(() => solPriceToLamports("0 SOL")).toThrow(/positive SOL amount/i);
    expect(() => solPriceToLamports("0.000000000 SOL")).toThrow(/positive SOL amount/i);
  });

  it("builds a ledger_solana_transfer_v1-shaped transfer from an Axon hire", () => {
    const t = buildLedgerTransfer({ agentId: "research-agent", price: "0.05 SOL" }, "ReceiverWallet111");
    expect(t).toEqual({ to: "ReceiverWallet111", lamports: "50000000", note: "Axon hire: research-agent" });
    // lamports must be a base-10 integer string, per their contract
    expect(t.lamports).toMatch(/^\d+$/);
    expect(t.note.length).toBeLessThanOrEqual(240);
  });

  it("caps the note at 240 chars (their contract limit)", () => {
    const t = buildLedgerTransfer({ agentId: "a".repeat(300), price: "1 SOL" });
    expect(t.note.length).toBeLessThanOrEqual(240);
  });

  it("hires ANONYMOUSLY by default — the Ledger account is the payer + authorization", () => {
    const receipt: LedgerReceipt = { status: "submitted", signature: "SigABC", from: "LedgerAcct" };
    const body = ledgerReceiptToTask({ to: "research-agent", task: "do it", receipt });
    expect(body).toEqual({
      from: "anonymous",            // NOT a registered agent — Axon would expect that agent's wallet to sign
      to: "research-agent",
      task: "do it",
      paymentSignature: "SigABC",   // Axon verifies this SOL payment on-chain
      payerWallet: "LedgerAcct",    // the Ledger account, checked as the tx signer
    });
  });

  it("won't hire on a transfer the Ledger didn't submit", () => {
    const receipt: LedgerReceipt = { status: "rejected", signature: "", from: "" };
    expect(() => ledgerReceiptToTask({ to: "b", task: "t", receipt })).toThrow(/not submitted/i);
  });
});

describe("AgenC Ledger — full route flow", () => {
  const LEDGER = "So11111111111111111111111111111111111111112"; // a valid pubkey acting as the Ledger account

  function solAgent(price = "0.05 SOL") {
    const agentId = `sol-${randomUUID().slice(0, 8)}`;
    createAgent({
      agentId,
      name: "Sol Agent",
      capabilities: ["research"],
      publicKey: `pk-${agentId}`,
      walletAddress: RECEIVER,
      provider: "anthropic",
      reputation: 0,
      createdAt: new Date().toISOString(),
    } as Parameters<typeof createAgent>[0]);
    getDb().prepare("UPDATE agents SET price = ? WHERE agent_id = ?").run(price, agentId);
    return agentId;
  }

  it("an anonymous Ledger-signed SOL hire settles through POST /api/tasks", async () => {
    const to = solAgent("0.05 SOL");
    // A submitted Ledger receipt: signed by the Ledger account, exactly the price
    // in lamports, sent to Axon's receiver. (mock verifier format.)
    const lamports = solPriceToLamports("0.05 SOL");
    const receipt: LedgerReceipt = {
      status: "submitted",
      from: LEDGER,
      signature: `mockpay:SOL:${lamports}:${LEDGER}:${RECEIVER}:${randomUUID().slice(0, 8)}`,
    };
    const body = ledgerReceiptToTask({ to, task: "summarize the top 5 L2s", receipt });

    const req = new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    const json = (await res.json()) as { taskId?: string; claimToken?: string; error?: string };

    expect(res.status).toBe(201);
    expect(json.taskId).toBeTruthy();
    expect(json.claimToken).toBeTruthy(); // anonymous hires get a claim token to read the output
  });

  it("rejects the hire if the Ledger account isn't the on-chain signer", async () => {
    const to = solAgent("0.05 SOL");
    const lamports = solPriceToLamports("0.05 SOL");
    // signature signed by a DIFFERENT wallet than payerWallet claims
    const receipt: LedgerReceipt = {
      status: "submitted",
      from: LEDGER,
      signature: `mockpay:SOL:${lamports}:SomeOtherSigner1111111111111111111111111111:${RECEIVER}:${randomUUID().slice(0, 8)}`,
    };
    const body = ledgerReceiptToTask({ to, task: "x", receipt });
    const req = new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(402); // payment not verified — signer mismatch
  });
});
