// Client-side non-custodial hire: the user's own Phantom wallet signs + pays the
// AgenC hire. Axon's server builds the (unsigned) transactions; this signs them.
//
// Two phases, because setTaskJobSpec can only run once the funded task exists:
//   1. /prepare  -> sign+send register+hire (funds the escrow), confirm
//   2. /finalize -> sign+send setTaskJobSpec, confirm

import { Connection, VersionedTransaction, PublicKey, type Transaction } from "@solana/web3.js";

interface PhantomProvider {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: PublicKey }>;
  signAndSendTransaction(tx: Transaction | VersionedTransaction): Promise<{ signature: string }>;
}

function getPhantom(): PhantomProvider | null {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const p = w.phantom?.solana ?? w.solana;
  return p && p.isPhantom ? p : null;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Translate AgenC's on-chain custom error codes into something a person can act
// on. Anything unmapped falls back to the raw code so it's still debuggable.
function friendlyRevert(err: unknown): string {
  const code = (() => {
    const ie = (err as { InstructionError?: [number, { Custom?: number }] })?.InstructionError;
    return Array.isArray(ie) && ie[1] && typeof ie[1].Custom === "number" ? ie[1].Custom : null;
  })();
  switch (code) {
    case 6265: return "This agent is at full capacity right now — try another agent, or try again shortly.";
    case 6320: return "This agent's listing can't be moderated right now — try another agent.";
    default: return `The hire was rejected on-chain${code !== null ? ` (code ${code})` : ""}. Try another agent or try again.`;
  }
}

// Poll for on-chain confirmation (with history search, so a slightly-late tx is
// still seen) — the next phase reads the account this tx created.
async function waitConfirm(conn: Connection, sig: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (value) {
      if (value.err) throw new Error(friendlyRevert(value.err));
      if (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized") return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("confirmation timed out (the tx may still land — check the explorer)");
}

export interface WalletHireResult {
  taskPda: string;
  explorerUrl: string;
}

// Best-effort record of a placed order for the My Hires panel. Never throws and
// never blocks the flow: the on-chain tx is the source of truth, this is only
// Axon's convenience index of it.
async function recordOrder(body: { wallet: string; kind: "hire" | "buy"; itemPda: string; name: string; price: string; txSig: string }) {
  try {
    await fetch("/api/agenc/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // tell an open My Orders panel to refresh — no reload needed to see it
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("axon-order-recorded"));
  } catch {
    // a failed convenience-copy write must never surface as a hire failure
  }
}

// Hire an AgenC listing with the user's own wallet. Returns the funded task once
// both transactions have landed. `onStep` reports progress for the UI.
// `label`/`price` (if given) are stored in the buyer's My Hires history.
export async function hireWithWallet(opts: {
  listingPda: string;
  task: string;
  label?: string;
  price?: string;
  rpcUrl?: string;
  onStep?: (msg: string) => void;
}): Promise<WalletHireResult> {
  const step = opts.onStep ?? (() => {});
  const phantom = getPhantom();
  if (!phantom) throw new Error("PHANTOM_NOT_FOUND");

  const rpcUrl = opts.rpcUrl ?? process.env.NEXT_PUBLIC_HELIUS_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");

  step("Connecting wallet…");
  const { publicKey } = await phantom.connect();
  const buyerPubkey = publicKey.toBase58();

  // Phase 1 — build register+hire (server), user signs + pays the escrow.
  step("Preparing hire…");
  const prep = await fetch("/api/agenc/hire/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listingPda: opts.listingPda, task: opts.task, buyerPubkey }),
  });
  const p = (await prep.json()) as {
    hireTx: string; taskPda: string; providerAgent: string; jobSpecHashHex: string; jobSpecUri: string; explorerUrl: string; error?: string;
  };
  if (!prep.ok) throw new Error(p.error ?? `prepare failed (${prep.status})`);

  step("Approve the hire in your wallet…");
  const { signature: hireSig } = await phantom.signAndSendTransaction(VersionedTransaction.deserialize(b64ToBytes(p.hireTx)));
  step("Confirming on-chain…");
  await waitConfirm(conn, hireSig);

  // Phase 2 — attest the now-funded task (server), user signs the job spec.
  step("Pinning the job spec…");
  const fin = await fetch("/api/agenc/hire/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      taskPda: p.taskPda, buyerPubkey, providerAgent: p.providerAgent,
      task: opts.task, jobSpecHashHex: p.jobSpecHashHex, jobSpecUri: p.jobSpecUri,
    }),
  });
  const f = (await fin.json()) as { setSpecTx: string; error?: string };
  if (!fin.ok) throw new Error(f.error ?? `finalize failed (${fin.status})`);

  step("Approve the job spec in your wallet…");
  const { signature: setSig } = await phantom.signAndSendTransaction(VersionedTransaction.deserialize(b64ToBytes(f.setSpecTx)));
  step("Finishing…");
  await waitConfirm(conn, setSig);

  // Record it for My Hires (best-effort). The funding signature (hireSig) is the
  // meaningful anchor — it's the tx that opened + escrowed the task.
  await recordOrder({ wallet: buyerPubkey, kind: "hire", itemPda: p.taskPda, name: opts.label ?? "", price: opts.price ?? "", txSig: hireSig });

  return { taskPda: p.taskPda, explorerUrl: p.explorerUrl };
}
