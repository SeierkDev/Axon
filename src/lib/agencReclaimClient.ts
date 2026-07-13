// Client-side non-custodial reclaim: if a cross-network hire wasn't delivered,
// the buyer's own Phantom wallet signs a cancelTask transaction to pull the
// escrow back. Axon's server builds the (unsigned) transaction; this signs it.
// Also exposes the live on-chain delivery status the panel shows per hire.

import { Connection, VersionedTransaction, PublicKey, type Transaction } from "@solana/web3.js";
import type { Delivery } from "@/lib/integrations/agencReclaim";

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

async function waitConfirm(conn: Connection, sig: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (value) {
      if (value.err) throw new Error("The reclaim was rejected on-chain. The hire may have just been delivered — refresh and check its status.");
      if (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized") return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("confirmation timed out (the tx may still land — check the explorer)");
}

// Read a hire's live on-chain delivery status (public — no wallet).
export async function fetchDelivery(taskPda: string): Promise<Delivery | null> {
  try {
    const r = await fetch(`/api/agenc/reclaim?taskPda=${encodeURIComponent(taskPda)}`);
    if (!r.ok) return null;
    const d = (await r.json()) as { delivery?: Delivery };
    return d.delivery ?? null;
  } catch {
    return null;
  }
}

// Reclaim the escrow of an undelivered hire. The user signs + pays a tiny fee;
// the escrow returns to their wallet. On confirmation, records the local order
// as reclaimed (best-effort). Returns the reclaim signature.
export async function reclaimWithWallet(opts: {
  taskPda: string;
  rpcUrl?: string;
  onStep?: (msg: string) => void;
}): Promise<{ signature: string; explorerUrl: string }> {
  const step = opts.onStep ?? (() => {});
  const phantom = getPhantom();
  if (!phantom) throw new Error("PHANTOM_NOT_FOUND");

  const rpcUrl = opts.rpcUrl ?? process.env.NEXT_PUBLIC_HELIUS_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");

  step("Connecting wallet…");
  const { publicKey } = await phantom.connect();
  const buyerPubkey = publicKey.toBase58();

  step("Preparing reclaim…");
  const prep = await fetch("/api/agenc/reclaim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskPda: opts.taskPda, buyerPubkey }),
  });
  const p = (await prep.json()) as { cancelTx?: string; error?: string };
  if (!prep.ok || !p.cancelTx) throw new Error(p.error ?? `reclaim prepare failed (${prep.status})`);

  step("Approve the reclaim in your wallet…");
  const { signature } = await phantom.signAndSendTransaction(VersionedTransaction.deserialize(b64ToBytes(p.cancelTx)));
  step("Confirming on-chain…");
  await waitConfirm(conn, signature);

  // Best-effort: mark the local order reclaimed (the on-chain cancel is the truth).
  try {
    await fetch("/api/agenc/reclaim", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: buyerPubkey, taskPda: opts.taskPda }),
    });
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("axon-order-recorded"));
  } catch {
    // a failed convenience-copy write must never surface as a reclaim failure
  }

  return { signature, explorerUrl: `https://solscan.io/tx/${signature}` };
}
