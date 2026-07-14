// The transaction guard: before an unsigned cross-network settlement is handed to
// the user's wallet, it must contain ONLY allow-listed programs and exactly the
// intended settlement leg referencing the real on-chain accounts. These lock the
// attacks it exists to stop — each fails on the pre-guard code.

import { describe, it, expect } from "vitest";
import { guardTx, TxGuardError, AGENC_PROGRAM, ATA_PROGRAM } from "@/lib/integrations/txGuard";

const good = "Good1111111111111111111111111111111111111111";
const buyer = "Buyer111111111111111111111111111111111111111";
const seller = "Seller11111111111111111111111111111111111111";
const treasury = "Treasury111111111111111111111111111111111111";
const attacker = "Attacker111111111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const purchase = (accts: string[]) => ({ programAddress: AGENC_PROGRAM, accounts: accts.map((address) => ({ address })) });
const ataCreate = { programAddress: ATA_PROGRAM, accounts: [{ address: buyer }] };
// the intended buy: the good, the buyer's authority, the real seller + treasury
const buySettlement = { program: AGENC_PROGRAM, count: 1, accounts: [good, buyer, seller, treasury] } as const;

describe("guardTx", () => {
  it("passes a clean USDC buy — ATA creates + one purchase to the real accounts", () => {
    expect(() =>
      guardTx({
        instructions: [ataCreate, ataCreate, purchase([good, seller, buyer, treasury, "mint", "tokenprog"])],
        allowedPrograms: [AGENC_PROGRAM, ATA_PROGRAM],
        settlement: buySettlement,
      }),
    ).not.toThrow();
  });

  it("passes a clean SOL buy — a single purchase, no token programs", () => {
    expect(() =>
      guardTx({
        instructions: [purchase([good, seller, buyer, treasury])],
        allowedPrograms: [AGENC_PROGRAM],
        settlement: buySettlement,
      }),
    ).not.toThrow();
  });

  it("rejects a smuggled foreign program (e.g. a raw SPL token transfer riding along)", () => {
    const foreign = { programAddress: TOKEN_PROGRAM, accounts: [{ address: attacker }] };
    expect(() =>
      guardTx({
        instructions: [purchase([good, seller, buyer, treasury]), foreign],
        allowedPrograms: [AGENC_PROGRAM, ATA_PROGRAM],
        settlement: buySettlement,
      }),
    ).toThrow(TxGuardError);
  });

  it("rejects a swapped payout recipient — the seller replaced by an attacker", () => {
    expect(() =>
      guardTx({
        instructions: [purchase([good, attacker, buyer, treasury])], // seller → attacker
        allowedPrograms: [AGENC_PROGRAM],
        settlement: buySettlement,
      }),
    ).toThrow(/found 0/);
  });

  it("rejects a second, extra settlement instruction", () => {
    expect(() =>
      guardTx({
        instructions: [purchase([good, seller, buyer, treasury]), purchase([good, seller, buyer, treasury])],
        allowedPrograms: [AGENC_PROGRAM],
        settlement: buySettlement,
      }),
    ).toThrow(/found 2/);
  });

  it("rejects when the settlement instruction is missing entirely", () => {
    expect(() =>
      guardTx({
        instructions: [ataCreate, ataCreate],
        allowedPrograms: [AGENC_PROGRAM, ATA_PROGRAM],
        settlement: buySettlement,
      }),
    ).toThrow(/found 0/);
  });

  it("SOL-path allowlist rejects a stray ATA-program instruction", () => {
    expect(() =>
      guardTx({
        instructions: [ataCreate, purchase([good, seller, buyer, treasury])],
        allowedPrograms: [AGENC_PROGRAM], // SOL path: ATA program not allowed
        settlement: buySettlement,
      }),
    ).toThrow(TxGuardError);
  });
});
