// The world only needs to know which address is visiting, so it can work out which agents are
// yours. No signing, no transactions.
//
// It speaks EIP-1193 directly, the same as the rest of the site. It deliberately does not reach for
// the shared WalletProvider: the world mounts its own canvas and the entry screen needs an address
// before the page chrome around it exists.

import { isPhone, metaMaskDeepLink, provider, type Eip1193 } from "@/lib/chain";

export function getInjectedWallet(): Eip1193 | null {
  return provider();
}

/**
 * Connect and return the address.
 *
 * Throws "WALLET_NOT_FOUND" on a desktop browser with no wallet, so the caller can offer to install
 * one. On a phone there is nothing to install into this browser: the wallet is almost certainly
 * already on the device, just not here, so the way in is its own browser.
 */
export async function connectWallet(): Promise<string> {
  const p = getInjectedWallet();
  if (!p) {
    const coarse =
      typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false);
    if (typeof navigator !== "undefined" && isPhone(navigator.userAgent, coarse)) {
      window.location.href = metaMaskDeepLink(window.location.href);
      // The page is navigating away, so park the promise rather than flashing an error first.
      return new Promise<string>(() => {});
    }
    throw new Error("WALLET_NOT_FOUND");
  }
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error("WALLET_NOT_FOUND");
  return address.toLowerCase();
}

/**
 * A wallet cannot be told to forget a site, so there is nothing to revoke from here. The caller
 * drops the address it is holding, which is the part it can actually do.
 */
export async function disconnectWallet(): Promise<void> {
  /* nothing to revoke */
}
