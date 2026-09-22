import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, decodeFunctionData } from "viem";
import { POT_ABI, FACTORY_ABI, launchParams, randomSalt, ZERO_ADDRESS } from "@/lib/launchAbi";
import { fixtureCalldata, fixtureDeployPairCalldata } from "../../scripts/gen-launch-calldata";

/**
 * The launch page signs a struct it describes in TypeScript against a contract that declares it in Solidity.
 * Nothing sat between those two descriptions, and they had drifted: the page flattened Socials into five
 * loose strings, omitted expectedEconomics, and put salt in the middle. Every one of those still encodes.
 * viem builds the calldata, the button works, and the transaction reverts in the user's wallet after they
 * have already approved it.
 *
 * So this reads the Solidity and rebuilds the signature from it. If a field is added, removed, renamed or
 * moved, the test fails here rather than in somebody's wallet. The source is the authority, not a copy of it.
 */

const SOL = (p: string) => readFileSync(join(process.cwd(), "contracts", p), "utf8");

/** Fields of a Solidity struct, in declaration order, as [type, name] pairs. */
function structFields(source: string, name: string): [string, string][] {
  const body = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(source)?.[1];
  if (!body) throw new Error(`struct ${name} not found`);
  return body
    .split(";")
    .map((l) => l.replace(/\/\/[^\n]*/g, "").trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\s+/);
      return [parts[0], parts[parts.length - 1]] as [string, string];
    });
}

describe("the launch ABI matches the contracts it signs against", () => {
  const ipons = SOL("src/interfaces/IPons.sol");

  it("TokenParams has the fields the page sends, in the same order", () => {
    const fields = structFields(ipons, "TokenParams");

    // A struct member stays one field, reported as "tuple". Flattening Socials into its five strings
    // would make this eight fields into twelve, which is precisely the bug this guards. Its contents are
    // checked in the next test.
    const expanded = fields.map(([type, fname]) =>
      /^[A-Z]/.test(type) ? ["tuple", fname] : [type, fname],
    );

    const fn = POT_ABI.find((a) => a.type === "function" && a.name === "launch");
    if (!fn || fn.type !== "function") throw new Error("launch missing from POT_ABI");
    const params = fn.inputs[0];
    if (params.type !== "tuple" || !("components" in params)) throw new Error("params is not a tuple");

    expect(params.components.map((c) => [c.type, c.name])).toEqual(expanded);
  });

  it("the nested socials tuple is five strings, named as Solidity names them", () => {
    const fn = POT_ABI.find((a) => a.type === "function" && a.name === "launch");
    if (!fn || fn.type !== "function") throw new Error("launch missing");
    const params = fn.inputs[0] as { components: readonly { name?: string; type: string; components?: readonly { name?: string; type: string }[] }[] };
    const socials = params.components.find((c) => c.name === "socials");

    expect(socials?.type).toBe("tuple");
    expect(socials?.components?.map((c) => [c.name, c.type])).toEqual(
      structFields(ipons, "Socials").map(([t, n]) => [n, t]),
    );
  });

  it("the arguments after the struct match BurnPot.launch", () => {
    const pot = SOL("src/BurnPot.sol");
    const sig = /function\s+launch\(([^)]*)\)/.exec(pot)?.[1];
    expect(sig).toBeTruthy();

    // BurnPot.launch(TokenParams calldata, uint256 launchConfigId, address[] calldata snipeExempt)
    expect(sig).toMatch(/uint256\s+launchConfigId/);
    expect(sig).toMatch(/address\[\]\s+calldata\s+snipeExempt/);

    const fn = POT_ABI.find((a) => a.type === "function" && a.name === "launch");
    if (!fn || fn.type !== "function") throw new Error("launch missing");
    expect(fn.inputs.slice(1).map((i) => [i.type, i.name])).toEqual([
      ["uint256", "launchConfigId"],
      ["address[]", "snipeExempt"],
    ]);
    expect(fn.stateMutability).toBe("payable");
  });

  it("deployPair matches the factory", () => {
    const f = SOL("src/AgentLaunchFactory.sol");
    expect(/function\s+deployPair\(\s*address\s+payable\s+dev\s*,\s*uint16\s+devBps/.test(f)).toBe(true);

    const fn = FACTORY_ABI.find((a) => a.type === "function" && a.name === "deployPair");
    if (!fn || fn.type !== "function") throw new Error("deployPair missing");
    expect(fn.inputs.map((i) => i.type)).toEqual(["address", "uint16"]);
  });

  it("what the page builds encodes and decodes back to itself", () => {
    const salt = randomSalt();
    const params = launchParams(
      { name: "Axon", symbol: "AXON", logo: "ipfs://x", description: "A record." },
      salt,
    );

    const data = encodeFunctionData({
      abi: POT_ABI,
      functionName: "launch",
      args: [params, 0n, [ZERO_ADDRESS as `0x${string}`]],
    });

    // A round trip proves the shape is self-consistent. The tests above are what prove it is the
    // right shape, since a wrong struct round-trips against itself perfectly well.
    const back = decodeFunctionData({ abi: POT_ABI, data });
    const sent = (back.args as unknown as [typeof params, bigint, string[]])[0];
    expect(sent.salt).toBe(salt);
    expect(sent.symbol).toBe("AXON");
    expect(sent.socials.twitter).toBe("");
    expect(sent.expectedEconomics).toBe(`0x${"0".repeat(64)}`);
    expect(sent.creatorTaxBps).toBe(0);
  });

  it("the fork test's fixtures are still the calldata the page builds", () => {
    // contracts/test/AgentLaunchFork.t.sol fires these exact bytes at the deployed factory and the real
    // Pons. A fixture that has drifted from the page proves nothing about the page, so it is compared
    // rather than trusted. Regenerate with: npx tsx scripts/gen-launch-calldata.ts
    const committed = (f: string) =>
      readFileSync(join(process.cwd(), "contracts", "test", "fixtures", f), "utf8").trim();

    expect(committed("launchCalldata.txt")).toBe(fixtureCalldata());
    expect(committed("deployPairCalldata.txt")).toBe(fixtureDeployPairCalldata());
  });

  it("the frozen pre-fix calldata is not accidentally the current one", () => {
    // If a future edit made the current encoding match the broken one again, the regression test in the
    // fork suite would still pass while proving the opposite of what it claims.
    const legacy = readFileSync(
      join(process.cwd(), "contracts", "test", "fixtures", "legacyBrokenCalldata.txt"),
      "utf8",
    ).trim();

    expect(legacy).not.toBe(fixtureCalldata());
    expect(legacy.slice(0, 10)).not.toBe(fixtureCalldata().slice(0, 10));
  });

  it("the bytes captured from Chrome still decode against the current ABI", () => {
    // contracts/test/BrowserCapture.t.sol launches these on a fork of the real chain. They are a snapshot
    // of what a browser produced, so unlike the other fixtures they cannot be regenerated from source,
    // and a snapshot that nothing checks is a test that passes forever while the page moves underneath it.
    // Decoding them against the current ABI is the tie: change the struct and this fails, which is the
    // signal to re-capture with scratch/browsercheck rather than to edit the fixture by hand.
    const captured = readFileSync(
      join(process.cwd(), "contracts", "test", "fixtures", "browserCapturedCalldata.txt"),
      "utf8",
    ).trim() as `0x${string}`;

    const back = decodeFunctionData({ abi: POT_ABI, data: captured });
    const params = (back.args as unknown as [Record<string, unknown>, bigint, string[]])[0];

    expect(back.functionName).toBe("launch");
    expect(params.name).toBe("Browser Check");
    expect(params.symbol).toBe("BCHK");
    // The page must not let the caller choose these: the pot overwrites them, and sending them empty is
    // what makes that obvious.
    expect(params.creatorFeeRecipient).toBe(ZERO_ADDRESS);
    expect(params.creatorTaxBps).toBe(0);
    expect(params.buybackEnabled).toBe(false);
    expect(params.expectedEconomics).toBe(`0x${"0".repeat(64)}`);
  });

  it("a salt is random rather than repeated", () => {
    expect(randomSalt()).not.toBe(randomSalt());
    expect(randomSalt()).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
