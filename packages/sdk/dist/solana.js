'use strict';

var web3_js = require('@solana/web3.js');
var splToken = require('@solana/spl-token');

// src/solana.ts
var DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
var PRIORITY_FEE_FLOOR = 1e4;
var PRIORITY_FEE_CEIL = 1e6;
var COMPUTE_UNIT_LIMIT = 6e4;
var CONFIRM_HARD_DEADLINE_MS = 12e4;
function assertWithinCap(amount, decimals, opts) {
  if (opts.maxAmountUsdc == null) return;
  if (!Number.isFinite(opts.maxAmountUsdc) || opts.maxAmountUsdc < 0) {
    throw new Error(`invalid maxAmountUsdc: ${opts.maxAmountUsdc} \u2014 must be a non-negative number`);
  }
  const d = Number.isFinite(decimals) ? decimals : 6;
  const capBaseUnits = BigInt(Math.round(opts.maxAmountUsdc * 10 ** d));
  if (amount > capBaseUnits) {
    const requested = Number(amount) / 10 ** d;
    throw new Error(
      `payment of ${requested} USDC exceeds the ${opts.maxAmountUsdc} USDC cap \u2014 refusing to sign (no funds moved)`
    );
  }
}
function toKeypair(signer) {
  if (signer instanceof web3_js.Keypair) return signer;
  return web3_js.Keypair.fromSecretKey(signer instanceof Uint8Array ? signer : Uint8Array.from(signer));
}
async function dynamicPriorityFee(conn) {
  try {
    const recent = await conn.getRecentPrioritizationFees();
    const fees = recent.map((r) => r.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
    if (fees.length === 0) return PRIORITY_FEE_FLOOR;
    const p = fees[Math.floor(fees.length * 0.75)] ?? PRIORITY_FEE_FLOOR;
    return Math.min(PRIORITY_FEE_CEIL, Math.max(PRIORITY_FEE_FLOOR, p));
  } catch {
    return PRIORITY_FEE_FLOOR;
  }
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sendWithRebroadcast(conn, rawTx, lastValidBlockHeight) {
  const signature = await conn.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 0 });
  let lastRebroadcast = Date.now();
  const startedAt = Date.now();
  for (; ; ) {
    let value = null;
    try {
      ({ value } = await conn.getSignatureStatus(signature, { searchTransactionHistory: false }));
    } catch {
      await sleep(1e3);
      continue;
    }
    if (value?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(value.err)}`);
    if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
      return signature;
    }
    let height = 0;
    try {
      height = await conn.getBlockHeight("confirmed");
    } catch {
    }
    if (height > lastValidBlockHeight) {
      const final = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (final.value?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(final.value.err)}`);
      if (final.value) return signature;
      throw new Error("blockhash expired before confirmation (network congestion) \u2014 no funds moved");
    }
    if (Date.now() - startedAt > CONFIRM_HARD_DEADLINE_MS) {
      const final = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (final.value?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(final.value.err)}`);
      if (final.value) return signature;
      throw new Error("payment confirmation could not be verified (RPC unreachable) \u2014 check the wallet before retrying");
    }
    if (Date.now() - lastRebroadcast >= 2e3) {
      try {
        await conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
      } catch {
      }
      lastRebroadcast = Date.now();
    }
    await sleep(1e3);
  }
}
function solanaPayer(signer, opts = {}) {
  const keypair = toKeypair(signer);
  const conn = new web3_js.Connection(opts.rpcUrl ?? DEFAULT_RPC_URL, "confirmed");
  return async (requirements) => {
    const option = requirements.accepts[0];
    if (!option) throw new Error("x402 requirements carried no payment option");
    const recipient = new web3_js.PublicKey(option.payToAddress);
    const mint = new web3_js.PublicKey(option.extra.contractAddress || option.asset);
    const decimals = option.extra.decimals;
    const amount = BigInt(option.maxAmountRequired);
    assertWithinCap(amount, decimals, opts);
    const fromAta = splToken.getAssociatedTokenAddressSync(mint, keypair.publicKey, true);
    const toAta = splToken.getAssociatedTokenAddressSync(mint, recipient, true);
    const priorityFee = opts.priorityFeeMicroLamports ?? await dynamicPriorityFee(conn);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new web3_js.Transaction().add(
      web3_js.ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      web3_js.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      splToken.createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, toAta, recipient, mint),
      splToken.createTransferCheckedInstruction(fromAta, mint, toAta, keypair.publicKey, amount, decimals)
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = keypair.publicKey;
    tx.sign(keypair);
    const signature = await sendWithRebroadcast(conn, tx.serialize(), lastValidBlockHeight);
    return { signature, from: keypair.publicKey.toBase58() };
  };
}
async function confirmViaStatus(conn, signature) {
  const deadline = Date.now() + CONFIRM_HARD_DEADLINE_MS;
  for (; ; ) {
    let value = null;
    try {
      ({ value } = await conn.getSignatureStatus(signature, { searchTransactionHistory: true }));
    } catch {
    }
    if (value?.err) throw new Error(`payment failed on-chain: ${JSON.stringify(value.err)}`);
    if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) return;
    if (Date.now() > deadline) return;
    await sleep(1e3);
  }
}
function walletPayer(wallet, opts = {}) {
  const conn = new web3_js.Connection(opts.rpcUrl ?? DEFAULT_RPC_URL, "confirmed");
  return async (requirements) => {
    if (!wallet.publicKey) throw new Error("wallet is not connected");
    const option = requirements.accepts[0];
    if (!option) throw new Error("x402 requirements carried no payment option");
    const payer = wallet.publicKey;
    const recipient = new web3_js.PublicKey(option.payToAddress);
    const mint = new web3_js.PublicKey(option.extra.contractAddress || option.asset);
    const amount = BigInt(option.maxAmountRequired);
    assertWithinCap(amount, option.extra.decimals, opts);
    const fromAta = splToken.getAssociatedTokenAddressSync(mint, payer, true);
    const toAta = splToken.getAssociatedTokenAddressSync(mint, recipient, true);
    const tx = new web3_js.Transaction().add(
      splToken.createAssociatedTokenAccountIdempotentInstruction(payer, toAta, recipient, mint),
      splToken.createTransferCheckedInstruction(fromAta, mint, toAta, payer, amount, option.extra.decimals)
    );
    tx.feePayer = payer;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    let signature;
    if (wallet.sendTransaction) {
      signature = await wallet.sendTransaction(tx, conn);
    } else if (wallet.signAndSendTransaction) {
      ({ signature } = await wallet.signAndSendTransaction(tx));
    } else {
      throw new Error("wallet must implement sendTransaction or signAndSendTransaction");
    }
    await confirmViaStatus(conn, signature);
    return { signature, from: payer.toBase58() };
  };
}
function payerAddress(signer) {
  return toKeypair(signer).publicKey.toBase58();
}
function walletMandateSigner(wallet) {
  return async (message) => {
    await wallet.connect?.();
    const signed = await wallet.signMessage(new TextEncoder().encode(message), "utf8");
    const bytes = signed instanceof Uint8Array ? signed : signed.signature;
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  };
}

exports.payerAddress = payerAddress;
exports.solanaPayer = solanaPayer;
exports.walletMandateSigner = walletMandateSigner;
exports.walletPayer = walletPayer;
//# sourceMappingURL=solana.js.map
//# sourceMappingURL=solana.js.map