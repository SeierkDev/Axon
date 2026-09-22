// The two ABIs the launch page signs against.
//
// These live here rather than inside the page because they are the one part of the flow that nothing was
// checking. The contracts have tests, including against the real Pons. The page has none, because it needs a
// wallet. In between sits a hand-written signature string, and a wrong one still encodes: viem builds the
// calldata happily, the button looks fine, and the transaction reverts in the user's wallet with the launch
// fee already committed.
//
// It was wrong. The first version flattened Socials into five loose strings, left out expectedEconomics
// entirely, and put salt in the middle instead of at the end. launchAbi.test.ts now compares every word of
// this against the compiled artifact, so the next edit to the struct fails a test instead of a launch.

import { parseAbi } from "viem";

export const FACTORY_ABI = parseAbi([
  "function deployPair(address dev, uint16 devBps) returns (address pot, address splitter)",
  "event AgentPairDeployed(address indexed dev, address indexed pot, address indexed splitter, uint16 devBps)",
]);

/**
 * Must match IPons.TokenParams field for field and in order: once encoded the struct is positional, and the
 * names here are only for us. The chain sees the order.
 */
export const POT_ABI = parseAbi([
  "function launch((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params, uint256 launchConfigId, address[] snipeExempt) payable returns (address token)",
]);

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_BYTES32 = `0x${"0".repeat(64)}` as `0x${string}`;

export interface LaunchMetadata {
  name: string;
  symbol: string;
  logo: string;
  description: string;
}

/**
 * The params struct for a launch.
 *
 * creatorFeeRecipient, creatorTaxBps and buybackEnabled are placeholders: BurnPot overwrites all three
 * before it forwards the call, which is the whole point of launching through the pot rather than straight
 * at Pons. Sending them filled in would not change the outcome, and sending them empty makes it obvious
 * that the caller does not get to choose them.
 *
 * expectedEconomics at zero means the launch accepts whatever terms the config gives it. A non-zero value
 * is Pons checking those terms against previewLaunchEconomics and reverting if they moved, which protects a
 * caller who priced the launch in advance. Nothing here prices anything in advance.
 */
export function launchParams(meta: LaunchMetadata, salt: `0x${string}`) {
  return {
    name: meta.name,
    symbol: meta.symbol,
    logo: meta.logo,
    description: meta.description,
    socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
    creatorFeeRecipient: ZERO_ADDRESS as `0x${string}`,
    creatorTaxBps: 0,
    buybackEnabled: false,
    expectedEconomics: ZERO_BYTES32,
    salt,
  } as const;
}

/** A launch salt. Random rather than derived, because a predictable one is a griefable one. */
export function randomSalt(): `0x${string}` {
  return `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;
}
