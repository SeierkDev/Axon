import { createWalletClient, http, createPublicClient, formatEther, custom, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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
    capWei = parseEther(String(opts.maxAmountEth));
  } catch {
    throw new Error(`invalid maxAmountEth: ${opts.maxAmountEth} \u2014 must be a non-negative amount`);
  }
  if (capWei < 0n) throw new Error(`invalid maxAmountEth: ${opts.maxAmountEth}`);
  if (amountWei > capWei) {
    throw new Error(
      `payment of ${formatEther(amountWei)} ETH exceeds the ${formatEther(capWei)} ETH cap \u2014 refusing to sign (no funds moved)`
    );
  }
}
var ERC20_TRANSFER = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }]
  }
];
var ERC20_BALANCE = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }]
  }
];
function requestedWei(requirements, chosen) {
  const option = chosen ?? requirements.accepts[0];
  if (!option) throw new Error("x402 requirements carried no payment option");
  const contract = option.extra?.contractAddress;
  const token = contract && /^0x[0-9a-fA-F]{40}$/.test(contract) ? contract : null;
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
  return { wei, to, token };
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
  const account = privateKeyToAccount(asPrivateKey(signer));
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const chain = chainDef(rpcUrl);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const reader = createPublicClient({ chain, transport: http(rpcUrl) });
  return async (requirements, option) => {
    const { wei, to, token } = requestedWei(requirements, option);
    if (!token) assertWithinCap(wei, opts);
    if (token) {
      const held = await reader.readContract({
        address: token,
        abi: ERC20_BALANCE,
        functionName: "balanceOf",
        args: [account.address]
      });
      if (held < wei) {
        throw new Error(
          `wallet holds ${held} units of ${token}, less than the ${wei} requested \u2014 no funds moved`
        );
      }
      const signature2 = await wallet.writeContract({
        address: token,
        abi: ERC20_TRANSFER,
        functionName: "transfer",
        args: [to, wei]
      });
      await settle(reader, signature2, opts);
      return { signature: signature2, from: account.address.toLowerCase() };
    }
    const balance = await reader.getBalance({ address: account.address });
    if (balance < wei) {
      throw new Error(
        `wallet holds ${formatEther(balance)} ETH, less than the ${formatEther(wei)} ETH requested \u2014 no funds moved`
      );
    }
    const signature = await wallet.sendTransaction({ to, value: wei });
    await settle(reader, signature, opts);
    return { signature, from: account.address.toLowerCase() };
  };
}
function walletPayer(wallet, opts = {}) {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const reader = createPublicClient({ chain: chainDef(rpcUrl), transport: custom(wallet) });
  return async (requirements, option) => {
    const { wei, to, token } = requestedWei(requirements, option);
    if (!token) assertWithinCap(wei, opts);
    const accounts = await wallet.request({ method: "eth_requestAccounts" });
    const from = accounts?.[0];
    if (!from) throw new Error("the wallet shared no account");
    if (token) {
      const data = "0xa9059cbb" + to.toLowerCase().replace(/^0x/, "").padStart(64, "0") + wei.toString(16).padStart(64, "0");
      const signature2 = await wallet.request({
        method: "eth_sendTransaction",
        params: [{ from, to: token, data }]
      });
      await settle(reader, signature2, opts);
      return { signature: signature2, from: from.toLowerCase() };
    }
    const balance = BigInt(await wallet.request({ method: "eth_getBalance", params: [from, "latest"] }));
    if (balance < wei) {
      throw new Error(
        `wallet holds ${formatEther(balance)} ETH, less than the ${formatEther(wei)} ETH requested \u2014 no funds moved`
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
  return privateKeyToAccount(asPrivateKey(signer)).address.toLowerCase();
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
  const account = privateKeyToAccount(asPrivateKey(signer));
  return (message) => account.signMessage({ message });
}

export { CHAIN_ID, DEFAULT_RPC_URL, keyMandateSigner, payerAddress, privateKeyPayer, walletMandateSigner, walletPayer };
//# sourceMappingURL=evm.mjs.map
//# sourceMappingURL=evm.mjs.map