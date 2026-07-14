// The transaction guard.
//
// Every cross-network settlement Axon composes — a hire, a buy, a reclaim — is an
// UNSIGNED transaction we hand to the user's own wallet to sign. Before it ever
// reaches the wallet, this guard asserts the transaction does exactly what the
// user asked and nothing else:
//
//   1. every instruction targets an ALLOW-LISTED program — nothing else can ride
//      along (no smuggled SPL transfer, no unknown program),
//   2. the transaction carries EXACTLY the expected number of settlement
//      instructions (the hire / purchase / cancel), and
//   3. that settlement instruction references the critical accounts we read
//      straight from on-chain — the target listing/good/task, the buyer's own
//      authority, and the real payout recipients — so a swapped recipient or a
//      redirected settlement is caught here.
//
// A compromised SDK, a hostile marketplace feed, or a future bug therefore can't
// produce a signable transaction that moves the buyer's funds somewhere they
// didn't intend. It's caught before it gets to them, not after they've signed.

import { AGENC_COORDINATION_PROGRAM_ADDRESS } from "@tetsuo-ai/marketplace-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export const AGENC_PROGRAM = String(AGENC_COORDINATION_PROGRAM_ADDRESS);
export const ATA_PROGRAM = String(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);

// Thrown when a composed transaction fails the guard. Surfaced as a 502 (an
// upstream/compose fault, never the user's doing) so a suspect tx is refused, not
// signed.
export class TxGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxGuardError";
  }
}

// The minimal instruction shape the guard reads (a superset of @solana/kit's
// Instruction). Kept structural so any instruction from the marketplace SDK or
// the SPL-token client passes without a cast.
export interface GuardInstruction {
  readonly programAddress: string;
  readonly accounts?: readonly { readonly address: string }[];
}

// Assert a composed, still-unsigned transaction is exactly what we intend.
// Throws TxGuardError on any deviation; returns silently when clean.
export function guardTx(opts: {
  instructions: readonly GuardInstruction[];
  // Every instruction's program must be in this set.
  allowedPrograms: readonly string[];
  // There must be exactly `count` instruction(s) on `program` that reference ALL
  // of `accounts` — the settlement leg(s) and their critical accounts.
  settlement: { program: string; count: number; accounts: readonly string[] };
}): void {
  const allowed = new Set(opts.allowedPrograms.map(String));
  for (const ix of opts.instructions) {
    if (!allowed.has(String(ix.programAddress))) {
      throw new TxGuardError(`transaction guard: unexpected program ${String(ix.programAddress)} in the transaction`);
    }
  }

  const need = opts.settlement.accounts.map(String);
  const matches = opts.instructions.filter((ix) => {
    if (String(ix.programAddress) !== opts.settlement.program) return false;
    const refs = new Set((ix.accounts ?? []).map((a) => String(a.address)));
    return need.every((n) => refs.has(n));
  });
  if (matches.length !== opts.settlement.count) {
    throw new TxGuardError(
      `transaction guard: expected ${opts.settlement.count} settlement instruction(s) carrying the intended accounts, found ${matches.length}`,
    );
  }
}
