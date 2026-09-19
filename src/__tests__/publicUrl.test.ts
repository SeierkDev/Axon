// The origin handed to a caller has to be one they can reach.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { publicOrigin, publicUrl } from "@/lib/publicUrl";

const req = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(new Request(url, { headers }));

describe("the public origin", () => {
  it("uses what the proxy reports, not the socket the container bound", () => {
    // Railway binds 0.0.0.0:8080 and this went out in the x402 quote as the resource being paid for.
    const r = req("https://0.0.0.0:8080/api/agents/research-agent/x402", {
      "x-forwarded-host": "axon-agents.com",
      "x-forwarded-proto": "https",
    });
    expect(publicOrigin(r)).toBe("https://axon-agents.com");
    expect(publicUrl(r, "/api/agents/research-agent/x402")).toBe(
      "https://axon-agents.com/api/agents/research-agent/x402",
    );
  });

  it("takes the first hop when the header has been chained", () => {
    const r = req("https://0.0.0.0:8080/x", {
      "x-forwarded-host": "axon-agents.com, internal.railway",
      "x-forwarded-proto": "https, http",
    });
    expect(publicOrigin(r)).toBe("https://axon-agents.com");
  });

  it("falls back to the plain host header", () => {
    const r = req("https://0.0.0.0:8080/x", { host: "axon-agents.com" });
    expect(publicOrigin(r)).toBe("https://axon-agents.com");
  });

  it("ignores a loopback host header rather than publishing it", () => {
    // The socket address can arrive in the header too. It is still not somewhere a caller can
    // reach, so it must not win over what the request itself says.
    for (const h of ["0.0.0.0:8080", "127.0.0.1:3000", "localhost:3000", "[::1]:8080"]) {
      const r = req("https://axon-agents.com/x", { host: h });
      expect(publicOrigin(r)).toBe("https://axon-agents.com");
    }
  });

  it("still works in local development, where loopback is the honest answer", () => {
    const r = req("http://localhost:3000/x", { host: "localhost:3000" });
    expect(publicOrigin(r)).toBe("http://localhost:3000");
  });

  it("prefers an explicitly configured URL and drops a trailing slash", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://configured.example/";
    try {
      const r = req("https://0.0.0.0:8080/x", { "x-forwarded-host": "axon-agents.com" });
      expect(publicOrigin(r)).toBe("https://configured.example");
    } finally {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });
});
