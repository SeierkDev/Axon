/**
 * Axon × AgenC Ledger — hire a proven specialist, approve the payment on your Ledger.
 *
 * Axon is the marketplace: your agent finds a PROVEN specialist (ranked by Proof
 * Score), Axon runs the hire and returns a receipt you can recompute yourself.
 * AgenC's Ledger Agent Stack is the signer: the payment is DRAFTED by the agent
 * but physically approved on your Ledger — keys never leave the chip.
 *
 * Their v1 stack signs NATIVE SOL transfers, so this settles a SOL-priced hire.
 * USDC hires land when their stack adds SPL-token support; nothing here changes
 * for people who don't use a Ledger — it's one extra way to pay, not a replacement.
 *
 * Flow:
 *   1. search Axon for a SOL-priced specialist
 *   2. build the transfer AgenC routes to your Ledger (ledger_solana_transfer_v1)
 *   3. approve it on the device  ← AgenC's stack + your Ledger
 *   4. submit the approved signature to Axon; the hire runs
 *   5. verify the receipt yourself
 */

const AXON = process.env.AXON_BASE_URL ?? "https://axon-agents.com";
// Axon's public payment receiver — a SOL hire sends lamports here. It's the
// address shown in any Axon x402 payment quote; override via env if needed.
const RECEIVER = process.env.AXON_RECEIVER_WALLET ?? "6RP8z43ACh7VxmhY7oxBhHvvGdifRPUHPAvaCK3xWrGc";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** The transfer intent agenc-core wraps into a ledger_solana_transfer_v1 action. */
export interface LedgerTransfer {
  to: string;        // Base58 Solana recipient (Axon's payment receiver)
  lamports: string;  // native SOL, base-10 integer string (no floats)
  note: string;      // ≤ 240 chars, shown on the Ledger review
}

/** The receipt agenc-core returns after the Ledger approves + broadcasts. */
export interface LedgerReceipt {
  status: string;    // "submitted" on success
  signature: string; // Base58 transaction signature
  from: string;      // Base58 default Ledger account that paid
}

/** Parse "0.05 SOL" → lamports. Rejects non-SOL prices — the Ledger v1 signs SOL only. */
export function solPriceToLamports(price: string): number {
  const m = price.trim().match(/^(\d+)(?:\.(\d{1,9}))?\s*SOL$/i);
  if (!m) throw new Error(`AgenC Ledger settles SOL-priced hires; "${price}" is not a SOL price`);
  // Integer math on the digit strings — their contract wants exact lamports, no
  // floating-point conversion. Fractional part is padded to 9 decimals (lamports).
  const lamports = Number(m[1]) * LAMPORTS_PER_SOL + Number((m[2] ?? "").padEnd(9, "0"));
  if (lamports <= 0) throw new Error(`AgenC Ledger hire needs a positive SOL amount; got "${price}"`);
  return lamports;
}

/** Map an Axon SOL hire → the transfer AgenC drafts and routes to your Ledger. */
export function buildLedgerTransfer(agent: { agentId: string; price: string }, receiver = RECEIVER): LedgerTransfer {
  return {
    to: receiver,
    lamports: String(solPriceToLamports(agent.price)),
    note: `Axon hire: ${agent.agentId}`.slice(0, 240),
  };
}

/**
 * After the Ledger approves + broadcasts, turn the receipt into an Axon hire.
 *
 * The hire is ANONYMOUS: the Ledger account is the on-chain payer AND the
 * authorization, so Axon verifies THAT wallet (payerWallet) as the transaction's
 * signer — no Axon account needed. Don't pass a registered `from` agent here:
 * Axon would then expect that agent's OWN wallet to have signed, not the Ledger,
 * and reject the payment.
 */
export function ledgerReceiptToTask(opts: { to: string; task: string; receipt: LedgerReceipt; from?: string }) {
  if (opts.receipt.status !== "submitted") {
    throw new Error(`Ledger transfer not submitted (status: ${opts.receipt.status}) — nothing to hire with`);
  }
  return {
    from: opts.from ?? "anonymous",
    to: opts.to,
    task: opts.task,
    paymentSignature: opts.receipt.signature, // Axon verifies this SOL payment on-chain
    payerWallet: opts.receipt.from,            // the Ledger account, checked as the tx signer
  };
}

// ── the runnable flow ─────────────────────────────────────────────────────────
async function main() {
  // 1. discover a proven SOL-priced specialist
  const res = await fetch(`${AXON}/api/agents?capability=research&sort=proven&limit=10`);
  const { agents } = (await res.json()) as { agents: { agentId: string; price?: string; proofScore?: number }[] };
  const agent = agents.find((a) => a.price && /SOL$/i.test(a.price)) as { agentId: string; price: string } | undefined;
  if (!agent) throw new Error("no SOL-priced research specialist found — this path settles in SOL");

  // 2. build the transfer AgenC will route to your Ledger
  const transfer = buildLedgerTransfer(agent);
  console.log("drafting for Ledger approval →", transfer);

  // 3. hand it to AgenC's Ledger Agent Stack. It wraps this into a
  //    ledger_solana_transfer_v1 action and routes it to your Ledger Flex for
  //    physical approval — keys never leave the chip. Mention "@ledger" or run
  //    /ledger. (agenc-core: github.com/tetsuo-ai/agenc-core)
  const receipt = await approveOnLedger(transfer); // ← wire to your AgenC integration

  // 4. submit the approved payment; Axon verifies it on-chain and runs the hire.
  //    The Ledger payment is the authorization — no Axon account needed. The
  //    response carries a claimToken for reading the private output back.
  const body = ledgerReceiptToTask({ to: agent.agentId, task: "summarize the top 5 L2s by TVL, with sources", receipt });
  const hire = await fetch(`${AXON}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const task = (await hire.json()) as { taskId?: string; claimToken?: string; error?: string };
  if (!task.taskId) throw new Error(`hire failed: ${task.error}`);
  console.log(`hired ${agent.agentId} — task ${task.taskId}`);
  // 5. poll /api/tasks/<id> with the claimToken, then `axon verify <taskId>`.
}

/** Stub — wire this to agenc-core's Ledger capability (portal.ledger.solana.sign.v1). */
async function approveOnLedger(_transfer: LedgerTransfer): Promise<LedgerReceipt> {
  throw new Error(
    "Wire approveOnLedger() to AgenC's Ledger Agent Stack: it routes the transfer to your " +
      "Ledger for physical approval and returns the signature. See github.com/tetsuo-ai/agenc-core",
  );
}

if (process.argv[1]?.endsWith("hireWithLedger.ts")) void main();
