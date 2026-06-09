"use client";

import { useEffect, useRef } from "react";
import SiteNav from "@/components/SiteNav";

export default function ApiReferencePage() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Dynamically load Swagger UI from CDN — avoids a large bundle dependency
    const script = document.createElement("script");
    script.src = "https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js";
    script.onload = () => {
      if (!containerRef.current) return;
      // @ts-expect-error SwaggerUIBundle injected by script tag
      const SwaggerUIBundle = window.SwaggerUIBundle;
      SwaggerUIBundle({
        url: "/api/openapi",
        dom_id: "swagger-ui",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: "BaseLayout",
        deepLinking: true,
        tryItOutEnabled: true,
        requestInterceptor: (req: { headers: Record<string, string> }) => req,
      });
    };
    document.head.appendChild(script);

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/swagger-ui-dist@5/swagger-ui.css";
    document.head.appendChild(link);

    return () => {
      if (script.parentNode === document.head) document.head.removeChild(script);
      if (link.parentNode === document.head) document.head.removeChild(link);
    };
  }, []);

  return (
    <div className="bg-white min-h-screen text-[#0a0a0a]">
      <SiteNav />

      <main className="max-w-6xl mx-auto px-6 pt-32 pb-24">
        <div className="mb-8 animate-fade-up">
          <p className="text-xs font-mono text-gray-400 tracking-wider mb-3">AXON PROTOCOL</p>
          <h1 className="text-3xl font-bold text-gray-900 mb-3">API Reference</h1>
          <p className="text-gray-500">
            Full HTTP API for Axon. Authenticate with{" "}
            <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">Authorization: Bearer &lt;key&gt;</code>
            {" "}or{" "}
            <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">X-API-Key: &lt;key&gt;</code>.
            <a
              href="/api/openapi"
              target="_blank"
              rel="noreferrer"
              className="ml-3 text-sm text-gray-400 hover:text-gray-600 underline underline-offset-2"
            >
              Download OpenAPI spec ↗
            </a>
          </p>
        </div>

        <div
          ref={containerRef}
          id="swagger-ui"
          className="rounded-xl border border-gray-200 overflow-hidden [&_.swagger-ui]:font-sans [&_.swagger-ui_.info]:hidden [&_.swagger-ui_.scheme-container]:hidden"
        />
      </main>
    </div>
  );
}
