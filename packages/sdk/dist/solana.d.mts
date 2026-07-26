import { Keypair, PublicKey, Transaction, Connection } from '@solana/web3.js';
import { X as X402PayFunction } from './types-CM-pk7Et.mjs';

interface SolanaPayerOptions {
    /** RPC endpoint. Default: mainnet-beta public RPC (use your own for production). */
    rpcUrl?: string;
    /** Fixed priority fee in micro-lamports/CU. Omit for a dynamic, clamped fee. */
    priorityFeeMicroLamports?: number;
    /**
     * Hard per-payment spend cap, in USDC. If a listing's requested amount exceeds
     * this, the payer refuses to sign — nothing is sent. Set this whenever an
     * autonomous agent pays on its own, so a malicious or buggy listing can't drain
     * the wallet. Omit for no cap (the payer trusts the requested amount).
     */
    maxAmountUsdc?: number;
}
/** Accepts a Keypair, a 64-byte secret key, or a JSON byte array. */
type SolanaSigner = Keypair | Uint8Array | number[];
/**
 * Build an `X402PayFunction` from a Solana wallet. Pass it to `AxonClient({ pay })`
 * or to `hire({ pay })`, and paid hires settle their USDC automatically.
 */
declare function solanaPayer(signer: SolanaSigner, opts?: SolanaPayerOptions): X402PayFunction;
/**
 * A connected browser wallet — the @solana/wallet-adapter shape (`sendTransaction`)
 * or a Phantom-style provider (`signAndSendTransaction`). Either is accepted.
 */
interface WalletLike {
    publicKey: PublicKey | null;
    sendTransaction?: (transaction: Transaction, connection: Connection) => Promise<string>;
    signAndSendTransaction?: (transaction: Transaction) => Promise<{
        signature: string;
    }>;
}
/**
 * Build an `X402PayFunction` from a connected browser wallet (Phantom, Solflare,
 * any @solana/wallet-adapter wallet). Use this in a dapp instead of `solanaPayer`,
 * which needs a raw key. No ComputeBudget instructions are added — the wallet
 * attaches its own priority fee and broadcasts.
 */
declare function walletPayer(wallet: WalletLike, opts?: SolanaPayerOptions): X402PayFunction;
/** The wallet address (base58) a signer will pay from — handy for logging or `from`. */
declare function payerAddress(signer: SolanaSigner): string;

export { type SolanaPayerOptions, type SolanaSigner, type WalletLike, payerAddress, solanaPayer, walletPayer };
