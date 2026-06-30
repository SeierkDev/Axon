import { describe, it, expect } from "vitest";
import {
  getProtocolInfo,
  negotiateVersion,
  compareVersions,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
} from "@/lib/protocol";

describe("protocol version negotiation", () => {
  it("advertises the current version, supported list, and capabilities", () => {
    const info = getProtocolInfo();
    expect(info.version).toBe(PROTOCOL_VERSION);
    expect(info.supported).toEqual([...SUPPORTED_VERSIONS]);
    expect(info.minVersion).toBe(info.supported[info.supported.length - 1]);
    expect(info.capabilities.length).toBeGreaterThan(0);
    expect(info.capabilities).toContain("task-slas");
  });

  it("orders versions correctly", () => {
    expect(compareVersions("1.0", "1.0")).toBe(0);
    expect(compareVersions("1.0", "1.1")).toBeLessThan(0);
    expect(compareVersions("2.0", "1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.10")).toBeLessThan(0); // numeric, not lexical
  });

  it("negotiates the highest version both sides share", () => {
    const r = negotiateVersion(["0.9", "1.0", "2.0"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version).toBe("1.0");
  });

  it("fails when there is no common version", () => {
    const r = negotiateVersion(["0.9", "2.0"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.supported).toEqual([...SUPPORTED_VERSIONS]);
  });

  it("returns capabilities on a successful negotiation", () => {
    const r = negotiateVersion(["1.0"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.capabilities).toContain("abuse-reports");
  });
});
