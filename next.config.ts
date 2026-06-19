import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Enable standalone output for Docker — copies only the minimal files needed
  output: process.env.DOCKER_BUILD === "1" ? "standalone" : undefined,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Only send HSTS over real HTTPS — avoids locking out local dev
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
            : []),
        ],
      },
      {
        // API routes are consumed by agents/SDKs — allow cross-origin reads but
        // lock down scripts/frames to prevent XSS escalation via the dashboard.
        source: "/api/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'none'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
      {
        // Dashboard and docs pages — tighter CSP than a typical SPA because
        // we control all assets. Inline styles/scripts are forbidden.
        source: "/((?!api).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next.js hydration requires 'unsafe-inline'; Turbopack dev also needs 'unsafe-eval'
              isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'", // Tailwind inlines via style attr
              "img-src 'self' data: https:",
              "font-src 'self'",
              // Allow the Solana RPC (Helius) for Axon Build's on-chain payment —
              // the browser fetches the blockhash and confirms the tx over https/wss.
              "connect-src 'self' https://*.helius-rpc.com wss://*.helius-rpc.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
