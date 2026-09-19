import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface TestWallet {
  /** The stored spelling: lowercase. */
  address: string;
  /** The spelling MetaMask hands back: mixed case. Use it to prove case is not load-bearing. */
  checksummed: string;
  /** A real EIP-191 personal_sign signature over `message`. */
  sign(message: string): Promise<string>;
}

/** A throwaway EVM account that can actually sign, so tests exercise real recovery. */
export function testWallet(): TestWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address.toLowerCase(),
    checksummed: account.address,
    sign: (message: string) => account.signMessage({ message }),
  };
}

/**
 * A stable EVM address derived from a seed, for tests that only need an owner to be distinct and
 * consistent rather than able to sign. Same seed, same address, every run.
 */
export function evmAddress(seed: string | number): string {
  return `0x${keccak256(toHex(String(seed))).slice(-40)}`;
}
