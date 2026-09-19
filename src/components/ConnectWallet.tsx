"use client";

import { useWallet } from "@/components/WalletProvider";
import { CHAIN_NAME } from "@/lib/chain";
import { shortAddress } from "@/lib/address";

const BASE =
  "text-sm px-4 py-1.5 rounded-md transition-colors font-medium disabled:opacity-60 disabled:cursor-not-allowed";
const SOLID =
  `${BASE} bg-[#0a0a0a] hover:bg-[#222] text-white dark:bg-white dark:text-[#0a0a0a] dark:hover:bg-gray-200`;
const OUTLINE =
  `${BASE} border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-500 dark:hover:border-gray-500`;

/**
 * Connect, switch chain, or show the connected address. One button, three states, because the thing
 * a person needs to do next is always exactly one thing.
 */
export function ConnectWallet({ className = "" }: { className?: string }) {
  const { address, busy, error, connect, disconnect, onRightChain, switchChain } = useWallet();

  if (!address) {
    return (
      <div className={className}>
        <button className={SOLID} onClick={() => void connect()} disabled={busy}>
          {busy ? "Check your wallet" : "Connect wallet"}
        </button>
        {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400 max-w-xs">{error}</p>}
      </div>
    );
  }

  if (!onRightChain) {
    return (
      <div className={className}>
        <button className={SOLID} onClick={() => void switchChain()} disabled={busy}>
          Switch to {CHAIN_NAME}
        </button>
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        className={`${OUTLINE} font-mono`}
        onClick={disconnect}
        title="Click to forget this address"
      >
        {shortAddress(address) ?? address}
      </button>
    </div>
  );
}
