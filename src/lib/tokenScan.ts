// What a token contract can do to you, read off the chain.
//
// Robinhood Chain is young and tokens launch on it constantly. A buyer has no way to find out,
// before they buy, whether the contract lets its owner mint more supply, freeze their wallet, or
// swap the rules out from under them. The information is all on chain and none of it is in front
// of anyone.
//
// This reads it. Every fact here comes from the contract's own bytecode or storage, so there is
// nothing to trust and nothing to keep up to date.
//
// It reports what it finds and stops there. "This contract has a mint function and ownership is
// not renounced" is checkable. "This is a scam" is a claim about somebody's project that can be
// wrong, in public, and it is not ours to make. Facts on the page, conclusions left to the reader.

import { toFunctionSelector } from "viem";
import { withRpc } from "./evm";
import { logger } from "./logger";

// ── the powers worth knowing about ───────────────────────────────────────────
//
// Each is a function that, if present, lets whoever controls the contract do something to holders
// after they have bought. The plain-English line is what a buyer actually needs; the signature is
// there so anyone can check the claim.

interface Power {
  signature: string;
  /** what having this function actually means for someone holding the token */
  meaning: string;
  severity: "high" | "medium" | "info";
}

const POWERS: Power[] = [
  { signature: "mint(address,uint256)", meaning: "New supply can be created after launch", severity: "high" },
  { signature: "mint(uint256)", meaning: "New supply can be created after launch", severity: "high" },
  { signature: "burnFrom(address,uint256)", meaning: "Tokens can be destroyed from a wallet that is not the caller's", severity: "high" },
  { signature: "pause()", meaning: "Transfers can be frozen for everyone", severity: "high" },
  { signature: "blacklist(address)", meaning: "An individual wallet can be blocked from trading", severity: "high" },
  { signature: "addBlackList(address)", meaning: "An individual wallet can be blocked from trading", severity: "high" },
  { signature: "setBlacklist(address,bool)", meaning: "An individual wallet can be blocked from trading", severity: "high" },
  { signature: "upgradeTo(address)", meaning: "The contract's code can be replaced entirely", severity: "high" },
  { signature: "upgradeToAndCall(address,bytes)", meaning: "The contract's code can be replaced entirely", severity: "high" },
  { signature: "setImplementation(address)", meaning: "The contract's code can be replaced entirely", severity: "high" },

  { signature: "setFee(uint256)", meaning: "The trading fee can be changed after launch", severity: "medium" },
  { signature: "setFees(uint256,uint256)", meaning: "The trading fee can be changed after launch", severity: "medium" },
  { signature: "setTaxes(uint256,uint256)", meaning: "The trading tax can be changed after launch", severity: "medium" },
  { signature: "setMaxTxAmount(uint256)", meaning: "A cap can be placed on how much one wallet may trade", severity: "medium" },
  { signature: "setMaxWalletAmount(uint256)", meaning: "A cap can be placed on how much one wallet may hold", severity: "medium" },
  { signature: "enableTrading()", meaning: "Trading can be switched on and off", severity: "medium" },
  { signature: "setTradingEnabled(bool)", meaning: "Trading can be switched on and off", severity: "medium" },
  { signature: "excludeFromFee(address)", meaning: "Chosen wallets can be exempted from the fee others pay", severity: "medium" },
  { signature: "withdraw()", meaning: "The contract can send its balance out", severity: "medium" },
  { signature: "rescueTokens(address,uint256)", meaning: "Tokens held by the contract can be removed", severity: "medium" },

  { signature: "owner()", meaning: "The contract has an owner", severity: "info" },
  { signature: "transferOwnership(address)", meaning: "Ownership can be handed to another address", severity: "info" },
  { signature: "renounceOwnership()", meaning: "Ownership can be given up", severity: "info" },
];

/** The 4-byte selector is what actually appears in compiled code, so that is what we look for. */
const POWER_SELECTORS: { selector: string; power: Power }[] = POWERS.map((power) => ({
  selector: toFunctionSelector(`function ${power.signature}`).slice(2).toLowerCase(),
  power,
}));

// ── proxies ──────────────────────────────────────────────────────────────────
//
// A proxy holds no logic. It forwards every call to a second contract, and whoever controls it can
// point it somewhere else later. Reading the proxy's own bytecode therefore says nothing useful
// about what the token does, and anything true today can be changed tomorrow.
//
// So we do not try to see through it. We detect it and say so, which is the more important fact
// anyway: the rules of this token are not fixed.

const SLOTS = {
  // EIP-1967
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  // EIP-1822 (UUPS)
  proxiable: "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
} as const;

/** EIP-1167 minimal proxy: a fixed 45-byte shape with the target address sitting inside it. */
const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;

export interface ProxyFinding {
  isProxy: boolean;
  /** which pattern matched, for anyone who wants to check */
  kind: "eip-1967" | "eip-1822" | "eip-1167" | "beacon" | null;
  implementation: string | null;
}

export interface TokenPower {
  signature: string;
  selector: string;
  meaning: string;
  severity: "high" | "medium" | "info";
}

export interface TokenFacts {
  address: string;
  /** false when there is no code at the address at all */
  isContract: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  proxy: ProxyFinding;
  ownership: {
    /** the contract exposes owner() */
    hasOwner: boolean;
    owner: string | null;
    /** owner is the zero address or the dead address: nobody can call the owner-only functions */
    renounced: boolean;
  };
  /** what the code allows, worst first */
  powers: TokenPower[];
  /** size of the deployed bytecode, a rough tell for how much is in there */
  codeSize: number;
  readAtBlock: string;
  readAt: string;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

const rpc = <T>(method: string, params: unknown[]) => withRpc((request) => request<T>(method, params));

/** The last 20 bytes of a 32-byte storage word, as an address. Null when the slot is empty. */
function addressFromSlot(word: string | null): string | null {
  if (!word) return null;
  const hex = word.replace(/^0x/, "").padStart(64, "0");
  const addr = `0x${hex.slice(24)}`.toLowerCase();
  return addr === ZERO ? null : addr;
}

/** Decode a solidity string return value. Falls back to null rather than throwing on junk. */
function decodeString(ret: string | null): string | null {
  if (!ret || ret === "0x") return null;
  const hex = ret.replace(/^0x/, "");
  try {
    // dynamic string: offset, length, then the bytes
    if (hex.length >= 128) {
      const len = parseInt(hex.slice(64, 128), 16);
      if (len > 0 && len <= 256 && hex.length >= 128 + len * 2) {
        const text = Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
        if (/^[\x20-\x7e\s]*$/.test(text)) return text.trim() || null;
      }
    }
    // some older tokens return a fixed bytes32 instead
    const text = Buffer.from(hex.slice(0, 64), "hex").toString("utf8").replace(/\0+$/, "");
    return /^[\x20-\x7e]+$/.test(text) ? text.trim() || null : null;
  } catch {
    return null;
  }
}

const bigFromHex = (ret: string | null): bigint | null => {
  if (!ret || ret === "0x") return null;
  try {
    return BigInt(ret);
  } catch {
    return null;
  }
};

/** One eth_call, returning null instead of throwing when the function is simply not there. */
async function call(address: string, signature: string): Promise<string | null> {
  try {
    return await rpc<string>("eth_call", [
      { to: address, data: toFunctionSelector(`function ${signature}`) },
      "latest",
    ]);
  } catch {
    return null;
  }
}

/**
 * Everything the chain will tell us about a token, in one pass.
 *
 * Read-only and side-effect free. Throws only when the address is unusable; a contract that
 * answers some calls and not others produces nulls in those fields rather than failing, because a
 * partial answer is still worth showing.
 */
export async function scanToken(rawAddress: string): Promise<TokenFacts> {
  const address = rawAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    throw new Error("Not an address");
  }

  const [code, head] = await Promise.all([
    rpc<string>("eth_getCode", [address, "latest"]),
    rpc<string>("eth_blockNumber", []),
  ]);

  const readAt = new Date().toISOString();
  const empty = !code || code === "0x";

  if (empty) {
    return {
      address,
      isContract: false,
      name: null, symbol: null, decimals: null, totalSupply: null,
      proxy: { isProxy: false, kind: null, implementation: null },
      ownership: { hasOwner: false, owner: null, renounced: false },
      powers: [],
      codeSize: 0,
      readAtBlock: head,
      readAt,
    };
  }

  const bytecode = code.toLowerCase();

  // ── proxy first: if it is one, the bytecode below describes the shell, not the token ──
  const proxy = await detectProxy(address, bytecode);

  // ── what the code can do ──
  // A selector appears in the dispatch table of any contract that implements it, so finding it is
  // evidence the function exists. It is deliberately a one-way test: finding it means present,
  // not finding it means absent from THIS bytecode, which is why a proxy is reported separately.
  const powers: TokenPower[] = [];
  for (const { selector, power } of POWER_SELECTORS) {
    if (bytecode.includes(selector) && !powers.some((p) => p.signature === power.signature)) {
      powers.push({
        signature: power.signature,
        selector: `0x${selector}`,
        meaning: power.meaning,
        severity: power.severity,
      });
    }
  }
  const rank = { high: 0, medium: 1, info: 2 };
  powers.sort((a, b) => rank[a.severity] - rank[b.severity] || a.signature.localeCompare(b.signature));

  // ── the ordinary token facts, and who owns it ──
  const [nameRet, symbolRet, decimalsRet, supplyRet, ownerRet] = await Promise.all([
    call(address, "name() returns (string)"),
    call(address, "symbol() returns (string)"),
    call(address, "decimals() returns (uint8)"),
    call(address, "totalSupply() returns (uint256)"),
    call(address, "owner() returns (address)"),
  ]);

  const owner = addressFromSlot(ownerRet);
  const decimals = bigFromHex(decimalsRet);
  const supply = bigFromHex(supplyRet);

  return {
    address,
    isContract: true,
    name: decodeString(nameRet),
    symbol: decodeString(symbolRet),
    decimals: decimals === null ? null : Number(decimals),
    totalSupply: supply === null ? null : supply.toString(),
    proxy,
    ownership: {
      hasOwner: ownerRet !== null && ownerRet !== "0x",
      owner,
      // No owner address means nobody can call the owner-only functions, whatever else is in there.
      renounced: ownerRet !== null && ownerRet !== "0x" && (owner === null || owner === DEAD),
    },
    powers,
    codeSize: (bytecode.length - 2) / 2,
    readAtBlock: head,
    readAt,
  };
}

/**
 * Whether this is the launchpad's own unmodified contract.
 *
 * Every token launched through Pons compiles to the same 3,248 bytes: no owner, no proxy, and
 * burnFrom as the only privileged function. That uniformity is the finding. It means a contract
 * report on a launchpad token says the same thing every time, and the interesting case is the
 * token that does NOT match, because someone chose to deploy something else.
 */
export function isStandardLaunchpadToken(f: TokenFacts): boolean {
  return (
    f.isContract &&
    !f.proxy.isProxy &&
    !f.ownership.hasOwner &&
    f.codeSize === 3248 &&
    f.powers.length === 1 &&
    f.powers[0].signature === "burnFrom(address,uint256)"
  );
}

/** Which of the known proxy patterns this contract is, if any. */
export async function detectProxy(address: string, bytecode: string): Promise<ProxyFinding> {
  const minimal = MINIMAL_PROXY.exec(bytecode);
  if (minimal) {
    return { isProxy: true, kind: "eip-1167", implementation: `0x${minimal[1]}` };
  }

  try {
    const [impl, beacon, proxiable] = await Promise.all([
      rpc<string>("eth_getStorageAt", [address, SLOTS.implementation, "latest"]),
      rpc<string>("eth_getStorageAt", [address, SLOTS.beacon, "latest"]),
      rpc<string>("eth_getStorageAt", [address, SLOTS.proxiable, "latest"]),
    ]);

    const implAddr = addressFromSlot(impl);
    if (implAddr) return { isProxy: true, kind: "eip-1967", implementation: implAddr };

    const beaconAddr = addressFromSlot(beacon);
    if (beaconAddr) return { isProxy: true, kind: "beacon", implementation: beaconAddr };

    // EIP-1822 stores the implementation in the same slot it uses as its marker.
    const proxiableAddr = addressFromSlot(proxiable);
    if (proxiableAddr) return { isProxy: true, kind: "eip-1822", implementation: proxiableAddr };
  } catch (err) {
    // A node that will not answer a storage read is not proof of anything either way.
    logger.warn("tokenScan.proxy_unreadable", "Could not read proxy slots", { err, address });
  }

  return { isProxy: false, kind: null, implementation: null };
}
