// Tests DNS-dependent paths in urlSecurity.ts via mocked node:dns/promises.
// Kept in a separate file so the mock is isolated to this module (vitest isolate:true).

import { vi, describe, it, expect, afterEach } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { validatePublicHttpUrl } from "@/lib/urlSecurity";
import { lookup } from "node:dns/promises";

const mockLookup = lookup as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.resetAllMocks();
});

// ── DNS failure path ──────────────────────────────────────────────────────────

describe("validatePublicHttpUrl: DNS lookup throws", () => {
  it("returns error string when lookup throws ENOTFOUND", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND nonexistent.invalid"));
    expect(await validatePublicHttpUrl("http://nonexistent.invalid/")).toBe(
      "endpoint host could not be resolved"
    );
  });
});

// ── DNS returns empty record list ─────────────────────────────────────────────

describe("validatePublicHttpUrl: DNS returns empty records", () => {
  it("rejects when lookup returns no records", async () => {
    mockLookup.mockResolvedValue([]);
    expect(await validatePublicHttpUrl("http://empty.example/")).toBe(
      "endpoint host resolves to a private or reserved address"
    );
  });
});

// ── DNS resolves to private IPv4 ──────────────────────────────────────────────

describe("validatePublicHttpUrl: DNS resolves to private IPv4", () => {
  it("rejects when DNS resolves hostname to 10.x.x.x", async () => {
    mockLookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    expect(await validatePublicHttpUrl("http://corp.internal.example/")).toBe(
      "endpoint host resolves to a private or reserved address"
    );
  });
});

// ── DNS resolves to private IPv6 ─────────────────────────────────────────────

describe("validatePublicHttpUrl: DNS resolves to private IPv6 (::1 loopback)", () => {
  it("rejects when DNS resolves to IPv6 loopback ::1", async () => {
    mockLookup.mockResolvedValue([{ address: "::1", family: 6 }]);
    expect(await validatePublicHttpUrl("http://loopback6.example/")).toBe(
      "endpoint host resolves to a private or reserved address"
    );
  });
});

describe("validatePublicHttpUrl: DNS resolves to ULA fc00::/7", () => {
  it("rejects when DNS resolves to IPv6 ULA fc00::1", async () => {
    mockLookup.mockResolvedValue([{ address: "fc00::1", family: 6 }]);
    expect(await validatePublicHttpUrl("http://ula.example/")).toBe(
      "endpoint host resolves to a private or reserved address"
    );
  });

  it("rejects when DNS resolves to IPv6 ULA fd00::1", async () => {
    mockLookup.mockResolvedValue([{ address: "fd00::1", family: 6 }]);
    expect(await validatePublicHttpUrl("http://ula2.example/")).toBe(
      "endpoint host resolves to a private or reserved address"
    );
  });
});

describe("validatePublicHttpUrl: DNS resolves to IPv6 link-local fe80::", () => {
  it("rejects when DNS resolves to link-local IPv6", async () => {
    mockLookup.mockResolvedValue([{ address: "fe80::1", family: 6 }]);
    expect(await validatePublicHttpUrl("http://ll6.example/")).toBe(
      "endpoint host resolves to a private or reserved address"
    );
  });
});

describe("validatePublicHttpUrl: DNS resolves to IPv4-mapped IPv6 (::ffff:192.168.x.x)", () => {
  it("rejects when DNS resolves to ::ffff: mapped private IPv4", async () => {
    mockLookup.mockResolvedValue([{ address: "::ffff:192.168.1.1", family: 6 }]);
    expect(await validatePublicHttpUrl("http://mapped.example/")).toBe(
      "endpoint host resolves to a private or reserved address"
    );
  });
});

// ── DNS resolves to public IPv6 ───────────────────────────────────────────────

describe("validatePublicHttpUrl: DNS resolves to public IPv6", () => {
  it("allows when DNS resolves to Cloudflare public IPv6 (2606:4700:4700::1111)", async () => {
    mockLookup.mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }]);
    expect(await validatePublicHttpUrl("http://ipv6-public.example/")).toBeNull();
  });

  it("allows when DNS resolves to public IPv4 (8.8.8.8)", async () => {
    mockLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    expect(await validatePublicHttpUrl("http://dns-resolved.example/")).toBeNull();
  });
});
