/**
 * Writes the calldata the launch page builds to a fixture the fork test fires at the real Pons.
 *
 * The point is that no human retypes the bytes. This imports the same module the browser imports and
 * encodes with the same function, so the fixture is the page's own output rather than a description of it.
 * launchAbi.test.ts fails if the committed fixture stops matching what this produces.
 *
 *   npx tsx scripts/gen-launch-calldata.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData } from "viem";
import { POT_ABI, FACTORY_ABI, launchParams } from "../src/lib/launchAbi";

// Fixed rather than random: a fixture that changes every run tells you nothing when it changes.
// The fork test knows these values and checks Pons recorded them.
// Lowercase, not mixed case: viem validates the checksum of any address with capitals in it, so a
// hand-typed mixed-case address throws before it ever encodes. Addresses reach this flow lowercased.
export const FIXTURE_DEV = "0x000000000000000000000000000000000000a9e4" as const;
export const FIXTURE_SALT = `0x${"11".repeat(32)}` as `0x${string}`;

export function fixtureCalldata(): `0x${string}` {
  return encodeFunctionData({
    abi: POT_ABI,
    functionName: "launch",
    args: [
      launchParams(
        {
          name: "Fixture Agent",
          symbol: "FIXT",
          logo: "ipfs://bafyfixture",
          description: "Built by the launch page, fired at the real Pons.",
        },
        FIXTURE_SALT,
      ),
      0n,
      [FIXTURE_DEV],
    ],
  });
}

/** The first of the two signatures: the factory call that deploys this agent's pot and splitter. */
export function fixtureDeployPairCalldata(): `0x${string}` {
  return encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "deployPair",
    args: [FIXTURE_DEV, 7000],
  });
}

const DIR = join(process.cwd(), "contracts", "test", "fixtures");

if (process.argv[1]?.endsWith("gen-launch-calldata.ts")) {
  writeFileSync(join(DIR, "launchCalldata.txt"), `${fixtureCalldata()}\n`);
  writeFileSync(join(DIR, "deployPairCalldata.txt"), `${fixtureDeployPairCalldata()}\n`);
  console.log(`wrote both fixtures to ${DIR}`);
}
