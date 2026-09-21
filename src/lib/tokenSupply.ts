// Where a token's supply actually sits, and how much is behind it.
//
// The contract is the same for every launch on this chain, so it is never the thing that
// distinguishes one token from another. What differs is who holds it and how much real money is
// underneath. Both are a handful of calls once the launch is known, because the launch tells us
// the two addresses that matter: the wallet that created it and the bonding curve holding the
// unsold supply.
//
// Deliberately not a holder list. Building one means replaying every Transfer since launch, which
// is dozens of capped log queries per token, and the top ten wallets of a token nobody has bought
// is a list of nobody. The three balances here are cheap, exact, and answer the question a buyer
// is actually asking: how much of this does the person who made it still control.

import { withRpc } from "./evm";
import { logger } from "./logger";

const DEAD = "0x000000000000000000000000000000000000dead";

/** balanceOf(address) */
const BALANCE_OF = "0x70a08231";

/**
 * getReserves() on the bonding curve, returning (quoteReserve, tokenReserve).
 *
 * This replaced reading the curve's native balance, which was wrong and quietly so. A launch can
 * be quoted in something other than the chain's native currency, and when it is, the curve's
 * native balance is zero however much has been raised. A token that was most of the way to
 * graduating reported nothing at all.
 *
 * The curve's own accounting does not have that problem: tokenReserve is what it still holds of
 * the token, in the token's own units, whatever it is being sold for.
 */
const GET_RESERVES = "0x0902f1ac";

const rpc = <T>(method: string, params: unknown[]) => withRpc((request) => request<T>(method, params));

export interface SupplyPosition {
  /** what the creator's wallet still holds, as a fraction of total supply, 0..1 */
  creatorShare: number | null;
  creatorBalance: string | null;
  /** still sitting in the bonding curve: supply nobody has bought yet */
  curveShare: number | null;
  curveBalance: string | null;
  /** sent to the dead address and gone */
  burnedShare: number | null;
  /**
   * How much of the supply the curve has sold, 0..1, from its own reserves.
   *
   * This replaced a progress figure measured in ETH against a fixed 4.2 target. Neither half of
   * that held: the target is not the same for every launch, and a launch quoted in something
   * other than the native currency leaves the curve's native balance at zero no matter how much
   * it has taken. Tokens sold is exact, needs no target, and means the same thing either way.
   */
  soldShare: number | null;
  /** true when the numbers below could not be read and should not be shown */
  unavailable: boolean;
}

const EMPTY: SupplyPosition = {
  creatorShare: null, creatorBalance: null,
  curveShare: null, curveBalance: null,
  burnedShare: null, soldShare: null,
  unavailable: true,
};

/** The curve's own (quoteReserve, tokenReserve). Null when it will not answer. */
async function curveReserves(curve: string): Promise<{ quoteReserve: bigint; tokenReserve: bigint } | null> {
  try {
    const ret = await rpc<string>("eth_call", [{ to: curve, data: GET_RESERVES }, "latest"]);
    const hex = (ret ?? "").replace(/^0x/, "");
    if (hex.length < 128) return null;
    return {
      quoteReserve: BigInt(`0x${hex.slice(0, 64)}`),
      tokenReserve: BigInt(`0x${hex.slice(64, 128)}`),
    };
  } catch {
    return null;
  }
}

/** One balanceOf call. Null rather than throwing, so one bad read does not lose the others. */
async function balanceOf(token: string, holder: string): Promise<bigint | null> {
  try {
    const data = `${BALANCE_OF}${holder.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
    const ret = await rpc<string>("eth_call", [{ to: token, data }, "latest"]);
    if (!ret || ret === "0x") return null;
    return BigInt(ret);
  } catch {
    return null;
  }
}

/**
 * Who is holding the supply, and what is under the curve.
 *
 * `totalSupply` comes from the scan that already read it, so this does not go and ask again.
 * Every field is independently nullable: a token whose curve will not answer still reports the
 * creator's share, because a partial answer is worth more than none.
 */
export async function supplyPosition(
  token: string,
  totalSupply: string | null,
  creator: string | null,
  curve: string | null,
): Promise<SupplyPosition> {
  const total = totalSupply ? BigInt(totalSupply) : 0n;
  if (total === 0n) return EMPTY;

  try {
    const [creatorBal, curveBal, deadBal, reserves] = await Promise.all([
      creator ? balanceOf(token, creator) : Promise.resolve(null),
      curve ? balanceOf(token, curve) : Promise.resolve(null),
      balanceOf(token, DEAD),
      curve ? curveReserves(curve) : Promise.resolve(null),
    ]);

    // Ratios in floating point are fine here: these are for reading, not for arithmetic that
    // anyone spends. The balances themselves stay exact as strings.
    const share = (v: bigint | null) => (v === null ? null : Number((v * 10_000n) / total) / 10_000);

    return {
      creatorShare: share(creatorBal),
      creatorBalance: creatorBal?.toString() ?? null,
      curveShare: share(curveBal),
      curveBalance: curveBal?.toString() ?? null,
      burnedShare: share(deadBal),
      // What the curve still holds against what it started with. Anything it no longer holds has
      // been bought, which is the only progress measure that does not need to know the target.
      soldShare:
        reserves === null || reserves.tokenReserve > total
          ? null
          : Number(((total - reserves.tokenReserve) * 10_000n) / total) / 10_000,
      unavailable: creatorBal === null && curveBal === null && deadBal === null,
    };
  } catch (err) {
    logger.warn("tokenSupply.unreadable", "Could not read the supply position", { err, token });
    return EMPTY;
  }
}
