"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { docsNav } from "@/lib/docs-nav";

interface Props {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export default function DocsSidebar({ mobileOpen, onClose }: Props) {
  const pathname = usePathname();

  const navContent = (
    <nav className="flex flex-col gap-6">
      {docsNav.map((section) => (
        <div key={section.section}>
          <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {section.section}
          </p>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onClose}
                    className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${
                      active
                        ? "bg-gray-100 dark:bg-gray-800 font-medium text-gray-900 dark:text-white"
                        : "text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      {/* Mobile slide-in panel */}
      <aside
        className={`md:hidden fixed left-0 top-14 bottom-0 z-40 w-64 overflow-y-auto border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-4 py-6 transition-transform duration-200 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {navContent}
      </aside>

      {/* Desktop sidebar — always visible */}
      <aside className="hidden md:block fixed left-0 top-14 bottom-0 w-64 overflow-y-auto border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-4 py-6">
        {navContent}
      </aside>
    </>
  );
}
