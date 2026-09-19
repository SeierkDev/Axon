import { toWei, weiToEth } from "@/lib/money";

/**
 * One amount, both representations, derived from each other so they cannot disagree.
 *
 * Writing the decimal and the exact unit as two separate literals is how a test ends up asserting
 * against an amount the code would never produce.
 */
export function ethAmount(amount: number | string): { amountEth: number; wei: bigint } {
  const wei = toWei(amount);
  if (wei === null) throw new Error(`ethAmount: '${amount}' is not an amount`);
  return { amountEth: weiToEth(wei), wei };
}
