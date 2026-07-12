// Client-side non-custodial goods purchase: the user's own Phantom wallet signs +
// pays the AgenC goods buy. Axon's server builds the (unsigned) transaction; this
// signs it. One transaction — buying a good needs no agent registration.

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

// Turn AgenC's on-chain custom errors into something a person can act on.
function friendlyRevert(err: unknown): string {
  const ie = (err as { InstructionError?: [number, { Custom?: number }] })?.InstructionError;
  const code = Array.isArray(ie) && ie[1] && typeof ie[1].Custom === "number" ? ie[1].Custom : null;
  // Common goods-market outcomes: sold out, listing changed price/serial under us,
  // self-purchase, delisted. Anything unmapped keeps the code for debugging.
  return `The purchase was rejected on-chain${code !== null ? ` (code ${code})` : ""}. The good may be sold out or its price changed — refresh and try again.`;
}

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

export interface WalletBuyResult {
  goodPda: string;
  explorerUrl: string;
}

// Best-effort record of a placed order for the My Buys / My Hires panel. Never
// throws and never blocks the flow: the on-chain tx is the source of truth, this
// is only Axon's convenience index of it.
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
    // a failed convenience-copy write must never surface as a purchase failure
  }
}

// Buy an AgenC good with the user's own wallet. Returns once the purchase has
// landed on-chain. `onStep` reports progress for the UI. `label`/`price` (if
// given) are stored in the buyer's My Buys history alongside the tx.
export async function buyWithWallet(opts: {
  goodPda: string;
  label?: string;
  price?: string;
  rpcUrl?: string;
  onStep?: (msg: string) => void;
}): Promise<WalletBuyResult> {
  const step = opts.onStep ?? (() => {});
  const phantom = getPhantom();
  if (!phantom) throw new Error("PHANTOM_NOT_FOUND");

  const rpcUrl = opts.rpcUrl ?? process.env.NEXT_PUBLIC_HELIUS_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");

  step("Connecting wallet…");
  const { publicKey } = await phantom.connect();
  const buyerPubkey = publicKey.toBase58();

  step("Preparing purchase…");
  const prep = await fetch("/api/agenc/buy/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goodPda: opts.goodPda, buyerPubkey }),
  });
  const p = (await prep.json()) as { buyTx: string; goodPda: string; explorerUrl: string; error?: string };
  if (!prep.ok) throw new Error(p.error ?? `prepare failed (${prep.status})`);

  step("Approve the purchase in your wallet…");
  const { signature } = await phantom.signAndSendTransaction(VersionedTransaction.deserialize(b64ToBytes(p.buyTx)));
  step("Confirming on-chain…");
  await waitConfirm(conn, signature);

  // Record it for My Buys (best-effort, keyed by the sale-specific signature).
  await recordOrder({ wallet: buyerPubkey, kind: "buy", itemPda: p.goodPda, name: opts.label ?? "", price: opts.price ?? "", txSig: signature });

  // Link to THIS purchase's transaction, not the shared listing account — the sig
  // is the only sale-specific identifier, and the server can't know it pre-sign.
  return { goodPda: p.goodPda, explorerUrl: `https://solscan.io/tx/${signature}` };
}
