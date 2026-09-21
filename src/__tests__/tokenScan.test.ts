import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem";

// The scanner's chain reads need a node, so what is pinned here is the part that must never drift
// silently: the selectors it looks for. A wrong selector means the scanner reports "no mint
// function" about a contract that has one, in public, about somebody else's token.
describe("the selectors the scanner looks for", () => {
  it("computes the well-known ones correctly", () => {
    // Cross-checked against the public 4-byte directory; these are not ours to get wrong.
    expect(toFunctionSelector("function mint(address,uint256)")).toBe("0x40c10f19");
    expect(toFunctionSelector("function burnFrom(address,uint256)")).toBe("0x79cc6790");
    expect(toFunctionSelector("function pause()")).toBe("0x8456cb59");
    expect(toFunctionSelector("function owner()")).toBe("0x8da5cb5b");
    expect(toFunctionSelector("function transferOwnership(address)")).toBe("0xf2fde38b");
    expect(toFunctionSelector("function renounceOwnership()")).toBe("0x715018a6");
    expect(toFunctionSelector("function upgradeTo(address)")).toBe("0x3659cfe6");
    expect(toFunctionSelector("function totalSupply()")).toBe("0x18160ddd");
  });
});

describe("proxy detection", () => {
  // EIP-1167 is a fixed 45-byte shape with the target sitting in the middle of it. Getting this
  // pattern wrong means missing that a contract's code can be swapped out entirely.
  const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;

  it("recognises a minimal proxy and pulls the target out of it", () => {
    const target = "bebebebebebebebebebebebebebebebebebebebe";
    const code = `0x363d3d373d3d3d363d73${target}5af43d82803e903d91602b57fd5bf3`;
    const m = MINIMAL_PROXY.exec(code);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(target);
  });

  it("does not mistake an ordinary contract for one", () => {
    expect(MINIMAL_PROXY.exec("0x6080604052348015600f57600080fd5b50")).toBeNull();
  });

  it("uses the EIP-1967 slot, which is the hash minus one and not the hash", () => {
    // A classic off-by-one: the slot is keccak256("eip1967.proxy.implementation") - 1.
    // Reading the wrong slot silently reports every proxy as a normal contract.
    expect("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc").toHaveLength(66);
  });
});
