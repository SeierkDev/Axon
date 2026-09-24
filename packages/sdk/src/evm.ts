// Optional EVM payment adapter for the Axon SDK.
//
// Turns a key or a browser wallet into an `X402PayFunction`, so paid hires just pay. Import from
// the `/evm` subpath so the core SDK stays dependency-free; this is what pulls in viem.
//
//   import { AxonClient } from "@axonprotocol/sdk";
//   import { privateKeyPayer } from "@axonprotocol/sdk/evm";
//
//   const axon = new AxonClient({ pay: privateKeyPayer(key, { rpcUrl }) });
//   await axon.hire({ to: "research-agent", task: "…" }); // paid? it pays and retries.
//
// Most of what the Solana adapter needed is gone: no associated token accounts to create, no
// separate fee currency to hold, no priority-fee auction, no blockhash to expire. What is left is
// the part that always mattered — refuse a payment bigger than the caller allowed, and never throw
// away a hash for a payment that might have landed.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseEther,
  formatEther,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
  SignMandate,
  X402PayFunction,
  X402PaymentOption,
  X402Requirements,
} from "./types";

/** Robinhood Chain, which is what Axon settles on. */
export const CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

const chainDef = (rpcUrl: string) =>
  ({
    id: CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }) as const;

export interface EvmPayerOptions {
  /** RPC endpoint. Defaults to the public Robinhood Chain node. */
  rpcUrl?: string;
  /**
   * Hard per-payment spend cap, in ETH. If a listing asks for more, the payer refuses to sign and
   * nothing is sent. Set this whenever an autonomous agent pays on its own, so a malicious or
   * buggy listing cannot drain the wallet. Omit for no cap.
   */
  maxAmountEth?: number | string;
  /** How long to wait for the payment to land before handing the hash over anyway. Default 120s. */
  confirmTimeoutMs?: number;
}

/**
 * Refuse a payment larger than the caller allowed, before anything is signed.
 *
 * Compared in wei. A cap checked in floating point is a cap you can slip past by a rounding error,
 * and the whole point of this one is that an agent paying on its own cannot be talked into more
 * than its owner agreed to.
 */
function assertWithinCap(amountWei: bigint, opts: EvmPayerOptions): void {
  if (opts.maxAmountEth == null) return;
  let capWei: bigint;
  try {
    capWei = parseEther(String(opts.maxAmountEth));
  } catch {
    throw new Error(`invalid maxAmountEth: ${opts.maxAmountEth} — must be a non-negative amount`);
  }
  if (capWei < 0n) throw new Error(`invalid maxAmountEth: ${opts.maxAmountEth}`);
  if (amountWei > capWei) {
    throw new Error(
      `payment of ${formatEther(amountWei)} ETH exceeds the ${formatEther(capWei)} ETH cap — refusing to sign (no funds moved)`,
    );
  }
}

/** The amount a listing is asking for, in wei. */
/** transfer(address,uint256), the only token call a payer ever needs. */
const ERC20_TRANSFER = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const ERC20_BALANCE = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * The amount and recipient for one option.
 *
 * Takes the option it was handed rather than reaching for accepts[0], because a 402 can offer both
 * ETH and a token and the caller has already chosen. Reading the first entry regardless is how the
 * token option stayed invisible no matter what anyone asked for.
 */
function requestedWei(
  requirements: X402Requirements,
  chosen?: X402PaymentOption,
): { wei: bigint; to: Address; token: Address | null } {
  const option = chosen ?? requirements.accepts[0];
  if (!option) throw new Error("x402 requirements carried no payment option");
  const contract = option.extra?.contractAddress;
  const token = contract && /^0x[0-9a-fA-F]{40}$/.test(contract) ? (contract as Address) : null;
  const to = option.payToAddress as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new Error(`x402 requirements named '${option.payToAddress}', which is not an EVM address`);
  }
  // maxAmountRequired is already the exact unit. Parsing it as a decimal would be wrong by 1e18.
  let wei: bigint;
  try {
    wei = BigInt(option.maxAmountRequired);
  } catch {
    throw new Error(`x402 requirements carried an unreadable amount: ${option.maxAmountRequired}`);
  }
  if (wei <= 0n) throw new Error("x402 requirements asked for a non-positive amount");
  return { wei, to, token };
}

/** Accepts a 0x-prefixed private key, with or without the prefix. */
export type EvmSigner = string;

function asPrivateKey(raw: EvmSigner): Hex {
  const t = String(raw).trim();
  const hex = t.startsWith("0x") ? t : `0x${t}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("private key must be 32 bytes of hex, with or without the 0x prefix");
  }
  return hex as Hex;
}

/** Pay from a key this process holds. */
export function privateKeyPayer(signer: EvmSigner, opts: EvmPayerOptions = {}): X402PayFunction {
  const account = privateKeyToAccount(asPrivateKey(signer));
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const chain = chainDef(rpcUrl);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const reader = createPublicClient({ chain, transport: http(rpcUrl) });

  return async (requirements: X402Requirements, option?: X402PaymentOption) => {
    const { wei, to, token } = requestedWei(requirements, option);
    // The cap is an ETH ceiling and cannot speak for an arbitrary token, so it applies to the
    // native lane only. A token payment is bounded by the quote the server issued instead.
    if (!token) assertWithinCap(wei, opts);

    // Check the balance before asking anyone to sign, so a short wallet fails here rather than
    // after the fact with a vague "payment not confirmed".
    if (token) {
      const held = (await reader.readContract({
        address: token, abi: ERC20_BALANCE, functionName: "balanceOf", args: [account.address],
      })) as bigint;
      if (held < wei) {
        throw new Error(
          `wallet holds ${held} units of ${token}, less than the ${wei} requested — no funds moved`,
        );
      }
      const signature = await wallet.writeContract({
        address: token, abi: ERC20_TRANSFER, functionName: "transfer", args: [to, wei],
      });
      await settle(reader, signature, opts);
      return { signature, from: account.address.toLowerCase() };
    }

    const balance = await reader.getBalance({ address: account.address });
    if (balance < wei) {
      throw new Error(
        `wallet holds ${formatEther(balance)} ETH, less than the ${formatEther(wei)} ETH requested — no funds moved`,
      );
    }

    const signature = await wallet.sendTransaction({ to, value: wei });
    await settle(reader, signature, opts);
    return { signature, from: account.address.toLowerCase() };
  };
}

/** A connected browser wallet: anything speaking EIP-1193, which is every EVM wallet. */
export interface WalletLike {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Pay from a wallet the person is holding, in a browser. */
export function walletPayer(wallet: WalletLike, opts: EvmPayerOptions = {}): X402PayFunction {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const reader = createPublicClient({ chain: chainDef(rpcUrl), transport: custom(wallet) });

  return async (requirements: X402Requirements, option?: X402PaymentOption) => {
    const { wei, to, token } = requestedWei(requirements, option);
    if (!token) assertWithinCap(wei, opts);

    const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
    const from = accounts?.[0];
    if (!from) throw new Error("the wallet shared no account");

    if (token) {
      // transfer(address,uint256), encoded by hand so the browser lane stays as thin as the rest of
      // this file: a selector, the recipient padded to a word, then the amount.
      const data =
        "0xa9059cbb" +
        to.toLowerCase().replace(/^0x/, "").padStart(64, "0") +
        wei.toString(16).padStart(64, "0");
      const signature = (await wallet.request({
        method: "eth_sendTransaction",
        params: [{ from, to: token, data }],
      })) as string;
      await settle(reader, signature, opts);
      return { signature, from: from.toLowerCase() };
    }

    const balance = BigInt((await wallet.request({ method: "eth_getBalance", params: [from, "latest"] })) as string);
    if (balance < wei) {
      throw new Error(
        `wallet holds ${formatEther(balance)} ETH, less than the ${formatEther(wei)} ETH requested — no funds moved`,
      );
    }

    const signature = (await wallet.request({
      method: "eth_sendTransaction",
      params: [{ from, to, value: `0x${wei.toString(16)}` }],
    })) as string;
    await settle(reader, signature, opts);
    return { signature, from: from.toLowerCase() };
  };
}

/**
 * Wait for the payment to land, but hand the hash back either way.
 *
 * Axon re-verifies the hash on-chain and is the source of truth, and the same hash is retryable, so
 * a slow-but-successful payment must never be thrown away. Only a transaction the chain says
 * actually failed is an error here.
 */
async function settle(
  reader: ReturnType<typeof createPublicClient>,
  hash: string,
  opts: EvmPayerOptions,
): Promise<void> {
  try {
    const receipt = await reader.waitForTransactionReceipt({
      hash: hash as Hex,
      timeout: opts.confirmTimeoutMs ?? 120_000,
    });
    if (receipt.status !== "success") throw new Error(`payment ${hash} reverted on-chain`);
  } catch (err) {
    if (err instanceof Error && /reverted on-chain/.test(err.message)) throw err;
    // Timed out or could not read. Not a verdict, so say nothing and let the server decide.
  }
}

/** The address a key pays from, without sending anything. */
export function payerAddress(signer: EvmSigner): string {
  return privateKeyToAccount(asPrivateKey(signer)).address.toLowerCase();
}

/** A wallet that can sign a message: the same EIP-1193 shape. */
export type MessageSigningWallet = WalletLike;

/**
 * Sign a purchase authorisation with a browser wallet.
 *
 * EIP-191 personal_sign, because that is what Axon recovers the signer from. Note the argument
 * order: personal_sign takes the message first and the address second, the opposite of eth_sign,
 * and getting it the wrong way round produces a signature that recovers to nobody.
 */
export function walletMandateSigner(wallet: MessageSigningWallet): SignMandate {
  return async (message: string) => {
    const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
    const from = accounts?.[0];
    if (!from) throw new Error("the wallet shared no account");
    return (await wallet.request({ method: "personal_sign", params: [message, from] })) as string;
  };
}

/** Sign a purchase authorisation with a key this process holds. */
export function keyMandateSigner(signer: EvmSigner): SignMandate {
  const account = privateKeyToAccount(asPrivateKey(signer));
  return (message: string) => account.signMessage({ message });
}
