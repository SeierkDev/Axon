"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/docs",       label: "Docs" },
  { href: "/agents",     label: "Agents" },
  { href: "/analytics",  label: "Analytics" },
  { href: "/dashboard",  label: "Dashboard" },
  { href: "/publish",    label: "Publish" },
  { href: "/litepaper",  label: "Litepaper", desktopOnly: true },
];

export default function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close drawer on route change
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setOpen(false); }, [pathname]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  function isActive(href: string) {
    if (href === "/docs") return pathname.startsWith("/docs");
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center">
            <Image src="/axon-logo.png" alt="Axon" width={48} height={48} className="h-12 w-12 object-contain" style={{ mixBlendMode: "multiply" }} priority />
          </Link>

          {/* Desktop links */}
          <div className="hidden md:flex items-center gap-8">
            {LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`text-sm transition-colors ${
                  isActive(href) ? "text-gray-900 font-medium" : "text-gray-400 hover:text-gray-900"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-3">
            {/* Twitter / X */}
            <a
              href="https://x.com/axon402"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Twitter / X"
              className="hidden sm:flex text-gray-400 hover:text-gray-700 transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.253 5.622ZM17.083 20.02h1.833L7.084 4.126H5.117Z" />
              </svg>
            </a>
            {/* GitHub */}
            <a
              href="https://github.com/SeierkDev/Axon"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              className="hidden sm:flex text-gray-400 hover:text-gray-700 transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
              </svg>
            </a>
            <Link
              href="/onboarding"
              className="hidden sm:block text-sm px-4 py-1.5 bg-[#0a0a0a] hover:bg-[#222] text-white rounded-md transition-colors font-medium"
            >
              Get Started
            </Link>
            {/* Hamburger */}
            <button
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              className="md:hidden flex flex-col justify-center items-center w-9 h-9 rounded-lg border border-gray-200 hover:border-gray-400 transition-colors gap-[5px]"
            >
              <span className={`block w-4 h-px bg-gray-700 transition-transform origin-center ${open ? "rotate-45 translate-y-[6px]" : ""}`} />
              <span className={`block w-4 h-px bg-gray-700 transition-opacity ${open ? "opacity-0" : ""}`} />
              <span className={`block w-4 h-px bg-gray-700 transition-transform origin-center ${open ? "-rotate-45 -translate-y-[6px]" : ""}`} />
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile drawer */}
      {open && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-black/20" />
          <div
            className="absolute top-14 left-0 right-0 bg-white border-b border-gray-200 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 space-y-1">
              {LINKS.filter((l) => !l.desktopOnly).map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center justify-between py-2.5 text-sm border-b border-gray-50 last:border-0 transition-colors ${
                    isActive(href) ? "text-gray-900 font-medium" : "text-gray-500 hover:text-gray-900"
                  }`}
                >
                  {label}
                  {isActive(href) && <span className="w-1.5 h-1.5 rounded-full bg-gray-900" />}
                </Link>
              ))}
              <div className="pt-3">
                <Link
                  href="/onboarding"
                  className="block w-full text-center py-2.5 rounded-lg bg-[#0a0a0a] text-white text-sm font-medium hover:bg-[#222] transition-colors"
                >
                  Get Started
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
