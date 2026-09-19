import { S as SignMandate, X as X402PayFunction } from './types-DF1Yb2-l.js';

/** Robinhood Chain, which is what Axon settles on. */
declare const CHAIN_ID = 4663;
declare const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
interface EvmPayerOptions {
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
/** Accepts a 0x-prefixed private key, with or without the prefix. */
type EvmSigner = string;
/** Pay from a key this process holds. */
declare function privateKeyPayer(signer: EvmSigner, opts?: EvmPayerOptions): X402PayFunction;
/** A connected browser wallet: anything speaking EIP-1193, which is every EVM wallet. */
interface WalletLike {
    request(args: {
        method: string;
        params?: unknown[];
    }): Promise<unknown>;
}
/** Pay from a wallet the person is holding, in a browser. */
declare function walletPayer(wallet: WalletLike, opts?: EvmPayerOptions): X402PayFunction;
/** The address a key pays from, without sending anything. */
declare function payerAddress(signer: EvmSigner): string;
/** A wallet that can sign a message: the same EIP-1193 shape. */
type MessageSigningWallet = WalletLike;
/**
 * Sign a purchase authorisation with a browser wallet.
 *
 * EIP-191 personal_sign, because that is what Axon recovers the signer from. Note the argument
 * order: personal_sign takes the message first and the address second, the opposite of eth_sign,
 * and getting it the wrong way round produces a signature that recovers to nobody.
 */
declare function walletMandateSigner(wallet: MessageSigningWallet): SignMandate;
/** Sign a purchase authorisation with a key this process holds. */
declare function keyMandateSigner(signer: EvmSigner): SignMandate;

export { CHAIN_ID, DEFAULT_RPC_URL, type EvmPayerOptions, type EvmSigner, type MessageSigningWallet, type WalletLike, keyMandateSigner, payerAddress, privateKeyPayer, walletMandateSigner, walletPayer };
