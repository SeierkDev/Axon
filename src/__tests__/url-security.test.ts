import { describe, it, expect } from "vitest";
import { validatePublicHttpUrl } from "@/lib/urlSecurity";

// Tests only cover fast-path rejections that don't require DNS resolution.
// DNS-dependent paths (resolving hostnames like example.com) are excluded from
// unit tests to avoid network calls in CI.

describe("validatePublicHttpUrl: fast-path rejections", () => {
  it("rejects a completely invalid URL", async () => {
    const result = await validatePublicHttpUrl("not-a-url");
    expect(result).toBe("endpoint must be a valid URL");
  });

  it("rejects non-HTTP protocols", async () => {
    expect(await validatePublicHttpUrl("ftp://example.com")).toBe("endpoint must use http or https");
    expect(await validatePublicHttpUrl("file:///etc/passwd")).toBe("endpoint must use http or https");
  });

  it("rejects localhost", async () => {
    expect(await validatePublicHttpUrl("http://localhost/api")).toBe("endpoint host is not allowed");
    expect(await validatePublicHttpUrl("https://localhost:8080")).toBe("endpoint host is not allowed");
  });

  it("rejects .localhost subdomains", async () => {
    expect(await validatePublicHttpUrl("http://app.localhost/")).toBe("endpoint host is not allowed");
  });

  it("rejects .local domains", async () => {
    expect(await validatePublicHttpUrl("http://myservice.local/")).toBe("endpoint host is not allowed");
  });

  it("rejects .internal domains", async () => {
    expect(await validatePublicHttpUrl("http://api.internal/")).toBe("endpoint host is not allowed");
  });

  it("rejects private IPv4 address 192.168.x.x", async () => {
    expect(await validatePublicHttpUrl("http://192.168.1.100/")).toBe("endpoint host is not allowed");
  });

  it("rejects loopback 127.0.0.1", async () => {
    expect(await validatePublicHttpUrl("http://127.0.0.1/")).toBe("endpoint host is not allowed");
  });

  it("rejects 10.x.x.x private range", async () => {
    expect(await validatePublicHttpUrl("http://10.0.0.1/")).toBe("endpoint host is not allowed");
  });

  it("rejects 172.16.x.x private range", async () => {
    expect(await validatePublicHttpUrl("http://172.16.0.1/")).toBe("endpoint host is not allowed");
  });

  it("accepts a clearly public IP address without DNS", async () => {
    // 8.8.8.8 is Google DNS — public IP, no DNS lookup needed for raw IPs
    const result = await validatePublicHttpUrl("https://8.8.8.8/test");
    expect(result).toBeNull();
  });

  it("accepts another public IP", async () => {
    // 1.1.1.1 is Cloudflare DNS — public
    const result = await validatePublicHttpUrl("https://1.1.1.1/test");
    expect(result).toBeNull();
  });
});

// ── isPrivateIpv4: additional reserved ranges ─────────────────────────────────

describe("validatePublicHttpUrl: additional private/reserved IPv4 ranges", () => {
  it("rejects 0.x.x.x (this-network range)", async () => {
    expect(await validatePublicHttpUrl("http://0.0.0.0/")).toBe("endpoint host is not allowed");
  });

  it("rejects 100.64.x.x (CGNAT / RFC 6598)", async () => {
    expect(await validatePublicHttpUrl("http://100.64.0.1/")).toBe("endpoint host is not allowed");
  });

  it("rejects 169.254.x.x (link-local / RFC 3927)", async () => {
    expect(await validatePublicHttpUrl("http://169.254.1.1/")).toBe("endpoint host is not allowed");
  });

  it("rejects 198.18.x.x (benchmark testing / RFC 2544)", async () => {
    expect(await validatePublicHttpUrl("http://198.18.0.1/")).toBe("endpoint host is not allowed");
  });

  it("rejects 224.x.x.x (multicast / reserved)", async () => {
    expect(await validatePublicHttpUrl("http://224.0.0.1/")).toBe("endpoint host is not allowed");
  });

  it("rejects 240.x.x.x (reserved for future use)", async () => {
    expect(await validatePublicHttpUrl("http://240.0.0.1/")).toBe("endpoint host is not allowed");
  });
});
