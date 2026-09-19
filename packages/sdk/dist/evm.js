'use strict';

var viem = require('viem');
var accounts = require('viem/accounts');

// src/evm.ts
var CHAIN_ID = 4663;
var DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
var chainDef = (rpcUrl) => ({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } }
});
function assertWithinCap(amountWei, opts) {
  if (opts.maxAmountEth == null) return;
  let capWei;
  try {
    capWei = viem.parseEther(String(opts.maxAmountEth));
  } catch {
    throw new Error(`invalid maxAmountEth: ${opts.maxAmountEth} \u2014 must be a non-negative amount`);
  }
  if (capWei < 0n) throw new Error(`invalid maxAmountEth: ${opts.maxAmountEth}`);
  if (amountWei > capWei) {
    throw new Error(
      `payment of ${viem.formatEther(amountWei)} ETH exceeds the ${viem.formatEther(capWei)} ETH cap \u2014 refusing to sign (no funds moved)`
    );
  }
}
function requestedWei(requirements) {
  const option = requirements.accepts[0];
  if (!option) throw new Error("x402 requirements carried no payment option");
  const to = option.payToAddress;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new Error(`x402 requirements named '${option.payToAddress}', which is not an EVM address`);
  }
  let wei;
  try {
    wei = BigInt(option.maxAmountRequired);
  } catch {
    throw new Error(`x402 requirements carried an unreadable amount: ${option.maxAmountRequired}`);
  }
  if (wei <= 0n) throw new Error("x402 requirements asked for a non-positive amount");
  return { wei, to };
}
function asPrivateKey(raw) {
  const t = String(raw).trim();
  const hex = t.startsWith("0x") ? t : `0x${t}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("private key must be 32 bytes of hex, with or without the 0x prefix");
  }
  return hex;
}
function privateKeyPayer(signer, opts = {}) {
  const account = accounts.privateKeyToAccount(asPrivateKey(signer));
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const chain = chainDef(rpcUrl);
  const wallet = viem.createWalletClient({ account, chain, transport: viem.http(rpcUrl) });
  const reader = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
  return async (requirements) => {
    const { wei, to } = requestedWei(requirements);
    assertWithinCap(wei, opts);
    const balance = await reader.getBalance({ address: account.address });
    if (balance < wei) {
      throw new Error(
        `wallet holds ${viem.formatEther(balance)} ETH, less than the ${viem.formatEther(wei)} ETH requested \u2014 no funds moved`
      );
    }
    const signature = await wallet.sendTransaction({ to, value: wei });
    await settle(reader, signature, opts);
    return { signature, from: account.address.toLowerCase() };
  };
}
function walletPayer(wallet, opts = {}) {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const reader = viem.createPublicClient({ chain: chainDef(rpcUrl), transport: viem.custom(wallet) });
  return async (requirements) => {
    const { wei, to } = requestedWei(requirements);
    assertWithinCap(wei, opts);
    const accounts = await wallet.request({ method: "eth_requestAccounts" });
    const from = accounts?.[0];
    if (!from) throw new Error("the wallet shared no account");
    const balance = BigInt(await wallet.request({ method: "eth_getBalance", params: [from, "latest"] }));
    if (balance < wei) {
      throw new Error(
        `wallet holds ${viem.formatEther(balance)} ETH, less than the ${viem.formatEther(wei)} ETH requested \u2014 no funds moved`
      );
    }
    const signature = await wallet.request({
      method: "eth_sendTransaction",
      params: [{ from, to, value: `0x${wei.toString(16)}` }]
    });
    await settle(reader, signature, opts);
    return { signature, from: from.toLowerCase() };
  };
}
async function settle(reader, hash, opts) {
  try {
    const receipt = await reader.waitForTransactionReceipt({
      hash,
      timeout: opts.confirmTimeoutMs ?? 12e4
    });
    if (receipt.status !== "success") throw new Error(`payment ${hash} reverted on-chain`);
  } catch (err) {
    if (err instanceof Error && /reverted on-chain/.test(err.message)) throw err;
  }
}
function payerAddress(signer) {
  return accounts.privateKeyToAccount(asPrivateKey(signer)).address.toLowerCase();
}
function walletMandateSigner(wallet) {
  return async (message) => {
    const accounts = await wallet.request({ method: "eth_requestAccounts" });
    const from = accounts?.[0];
    if (!from) throw new Error("the wallet shared no account");
    return await wallet.request({ method: "personal_sign", params: [message, from] });
  };
}
function keyMandateSigner(signer) {
  const account = accounts.privateKeyToAccount(asPrivateKey(signer));
  return (message) => account.signMessage({ message });
}

exports.CHAIN_ID = CHAIN_ID;
exports.DEFAULT_RPC_URL = DEFAULT_RPC_URL;
exports.keyMandateSigner = keyMandateSigner;
exports.payerAddress = payerAddress;
exports.privateKeyPayer = privateKeyPayer;
exports.walletMandateSigner = walletMandateSigner;
exports.walletPayer = walletPayer;
//# sourceMappingURL=evm.js.map
//# sourceMappingURL=evm.js.map