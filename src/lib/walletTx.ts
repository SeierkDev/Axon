// Sending a contract transaction from the visitor's own wallet, in the browser.
//
// The same three steps every page that sends one takes, in one place: be on Robinhood Chain first
// (and offer to add it, since most wallets have never heard of a chain this new), send, and wait for
// the chain to say whether it worked. Nothing here can sign for anyone; the wallet asks its owner.

import { CHAIN_ID_HEX, CHAIN_PARAMS, type Eip1193 } from "./chain";

const hex = (v: bigint) => `0x${v.toString(16)}`;

/** Switch the wallet to Robinhood Chain, adding it if the wallet does not know it. */
export async function ensureRobinhoodChain(p: Eip1193): Promise<void> {
  const chain = (await p.request({ method: "eth_chainId" })) as string;
  if (chain?.toLowerCase() === CHAIN_ID_HEX) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (e) {
    // 4902: the wallet has never heard of the chain, which for one this new is the ordinary case.
    if ((e as { code?: number }).code === 4902) {
      await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
    } else throw e;
  }
}

export async function sendWalletTx(
  p: Eip1193,
  tx: { from: string; to: string; data: `0x${string}`; value?: bigint },
): Promise<`0x${string}`> {
  await ensureRobinhoodChain(p);
  return (await p.request({
    method: "eth_sendTransaction",
    params: [{ from: tx.from, to: tx.to, data: tx.data, ...(tx.value ? { value: hex(tx.value) } : {}) }],
  })) as `0x${string}`;
}

/**
 * Wait for a transaction to land. Throws when the chain says it failed, or when it has not landed in
 * time; in that case the hash still stands, and the page should say so rather than claim failure.
 */
export async function waitForWalletTx(p: Eip1193, hash: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null)) as
      | { status?: string }
      | null;
    if (receipt) {
      if (receipt.status === "0x1" || receipt.status === "0x01") return;
      throw new Error("The transaction was reverted on chain");
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Still waiting for ${hash.slice(0, 10)}…; it may yet land`);
}
