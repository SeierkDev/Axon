// Talking to a browser wallet, over EIP-1193 directly.
//
// No connector library. MetaMask, Rabby and every browser wallet worth supporting expose
// `window.ethereum` with the same handful of methods used here, and a connector SDK would weigh more
// than everything it replaced.

export const CHAIN_ID = 4663;
export const CHAIN_ID_HEX = "0x1237";
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const CHAIN_NAME = "Robinhood Chain";

export const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: CHAIN_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER],
};

/** The slice of EIP-1193 this app uses. Deliberately not the whole interface. */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
  /** MetaMask only, and outside the standard: answers whether the wallet is unlocked without opening
   *  it. It is the one way to know, before calling anything, that a call would put the password
   *  screen in somebody's face. */
  _metamask?: { isUnlocked?: () => Promise<boolean> };
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export const provider = (): Eip1193 | null =>
  (typeof window !== "undefined" && window.ethereum) || null;

/**
 * Is this a phone, where a missing wallet means an app rather than an extension?
 *
 * The distinction is not cosmetic. On a desktop browser with no wallet the answer is "install one";
 * on a phone the wallet is almost certainly already installed, just not in this browser, and the way
 * in is its own browser. Coarse pointer alone would catch a touchscreen laptop, and the user agent
 * alone catches a desktop browser pretending, so both have to hold.
 */
export const isPhone = (ua: string, coarsePointer: boolean): boolean =>
  coarsePointer && /android|iphone|ipad|ipod|mobile/i.test(ua);

/**
 * The link that opens this page inside MetaMask's own browser, where an injected wallet exists.
 *
 * MetaMask's universal link takes the host and path with the scheme stripped. Everything after it is
 * carried through, so somebody who tapped connect halfway down the page lands back on the same spot.
 */
export function metaMaskDeepLink(href: string): string {
  try {
    const u = new URL(href);
    return `https://metamask.app.link/dapp/${u.host}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "https://metamask.app.link/";
  }
}

/**
 * May the page speak to the wallet on its own, before anybody has clicked anything?
 *
 * Only if this browser has connected here before, and only if the wallet is not locked. A locked
 * MetaMask treats any call from an origin it holds permissions for as a reason to open and ask for
 * the password, so a visitor who connected once gets the extension in their face on every later
 * arrival. `unlocked` is undefined on wallets that do not answer the question, and that is not a
 * reason to refuse: the call is silent on those.
 */
export const mayRestoreWallet = (wasConnected: boolean, unlocked: boolean | undefined): boolean =>
  wasConnected && unlocked !== false;

export const asHexChain = (v: unknown): number | null =>
  typeof v === "string" ? Number.parseInt(v, 16) : typeof v === "number" ? v : null;

/** EIP-191 personal_sign. Parameter order is message-then-address, which is the opposite of eth_sign. */
export async function signMessage(p: Eip1193, address: string, message: string): Promise<string> {
  return (await p.request({ method: "personal_sign", params: [message, address] })) as string;
}

/** What went wrong, in words somebody can act on. */
export function readableWalletError(e: unknown): string {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return "You rejected the request in your wallet.";
  if (err?.code === -32002) return "Your wallet already has a request open. Finish that one first.";
  if (err?.code === 4902) return `${CHAIN_NAME} is not in your wallet yet.`;
  return err?.message?.split("\n")[0] || "Your wallet refused the request.";
}
