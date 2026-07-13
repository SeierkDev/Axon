// Reclaim — the buyer side of making a cross-network hire SAFE.
//
// When you hire an AgenC agent from inside Axon, your own wallet funds an
// on-chain escrow (see agencHire.ts). If the work never comes, you shouldn't be
// stuck: this module lets you (a) read the hire's live on-chain delivery status,
// and (b) build an UNSIGNED cancelTask transaction your Phantom wallet signs to
// reclaim the escrow yourself. Non-custodial the whole way — Axon builds the tx,
// never holds funds, never signs. Once a task is Completed the escrow is gone to
// the worker, so reclaim is only offered while the work is still undelivered.
//
// Server-only (imports the marketplace SDK; NEVER import into client code).

import {
  getCancelTaskInstructionAsync,
  fetchMaybeTask,
  TaskStatus,
} from "@tetsuo-ai/marketplace-sdk";
import { createSolanaRpc, address, createNoopSigner } from "@solana/kit";
import { buildUnsignedTx } from "./agencHire";

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

export type DeliveryState =
  | "awaiting" // Open / InProgress — worker hasn't delivered; escrow reclaimable
  | "in_review" // PendingValidation — delivered, under validation; don't reclaim
  | "delivered" // Completed — work accepted, escrow paid out
  | "reclaimed" // Cancelled — escrow returned to you
  | "disputed" // Disputed — in dispute resolution
  | "gone"; // account closed / never existed

export interface Delivery {
  state: DeliveryState;
  reclaimable: boolean; // true only while awaiting (undelivered)
  onChainStatus: number | null; // raw TaskStatus, or null if the account is gone
}

// Map the on-chain TaskStatus to a buyer-facing delivery state. Reclaim is only
// safe while the task is still open/in-progress — never once it's delivered.
// Exported for tests: this is the safety invariant (reclaimable ⟺ undelivered).
export function toDelivery(status: number | null): Delivery {
  switch (status) {
    case TaskStatus.Open:
    case TaskStatus.InProgress:
      return { state: "awaiting", reclaimable: true, onChainStatus: status };
    case TaskStatus.PendingValidation:
      return { state: "in_review", reclaimable: false, onChainStatus: status };
    case TaskStatus.Completed:
      return { state: "delivered", reclaimable: false, onChainStatus: status };
    case TaskStatus.Cancelled:
      return { state: "reclaimed", reclaimable: false, onChainStatus: status };
    case TaskStatus.Disputed:
    case TaskStatus.RejectFrozen:
      return { state: "disputed", reclaimable: false, onChainStatus: status };
    default:
      return { state: "gone", reclaimable: false, onChainStatus: null };
  }
}

// Read a hire's live delivery status straight from its on-chain task account.
// Public data — no wallet needed. Fails soft to "gone" if the account can't be
// read (closed, wrong cluster, RPC hiccup), so the UI degrades gracefully.
export async function getDelivery(taskPda: string): Promise<Delivery> {
  try {
    const rpc = createSolanaRpc(RPC_URL);
    const acct = await fetchMaybeTask(rpc, address(taskPda));
    if (!acct.exists) return toDelivery(null);
    const status = (acct.data as { status?: number }).status;
    return toDelivery(typeof status === "number" ? status : null);
  } catch {
    return toDelivery(null);
  }
}

// Build the UNSIGNED cancelTask transaction for the buyer to sign with Phantom.
// The Async instruction derives every PDA (escrow, bonds, ATAs, protocol config)
// from just the task + authority; the buyer is the task creator, so authority is
// their own wallet as a noop signer (Phantom fills the signature). Refuses if the
// task isn't reclaimable, so a delivered hire can never be cancelled out from
// under the worker.
export class NotReclaimableError extends Error {} // a state conflict (409), not an upstream failure

export async function prepareCancel(opts: { taskPda: string; buyerPubkey: string }): Promise<{ cancelTx: string }> {
  const delivery = await getDelivery(opts.taskPda);
  if (delivery.state === "gone") {
    throw new NotReclaimableError("this hire's task account can't be read on-chain — nothing to reclaim");
  }
  if (!delivery.reclaimable) {
    const why =
      delivery.state === "delivered" ? "the work was delivered and accepted"
      : delivery.state === "in_review" ? "the work was delivered and is under review"
      : delivery.state === "reclaimed" ? "the escrow was already reclaimed"
      : "it's in dispute";
    throw new NotReclaimableError(`this hire can't be reclaimed — ${why}`);
  }

  const rpc = createSolanaRpc(RPC_URL);
  const buyer = createNoopSigner(address(opts.buyerPubkey));
  const cancelIx = await getCancelTaskInstructionAsync({
    task: address(opts.taskPda),
    authority: buyer,
  });
  const cancelTx = await buildUnsignedTx(rpc, buyer, [cancelIx]);
  return { cancelTx };
}
