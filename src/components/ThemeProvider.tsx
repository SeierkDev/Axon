"use client";
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: "light", toggle: () => {} });

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem("theme");
  return stored === "dark" ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const dark = theme === "dark";
    document.documentElement.classList.toggle("dark", dark);
    const color = dark ? "#0a0a0a" : "#ffffff";
    document.querySelector('meta[name="theme-color"]')?.remove();
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = color;
    document.head.appendChild(meta);

    // Force Safari to re-evaluate the theme-color and repaint browser chrome
    history.replaceState(null, "", window.location.href);

    // Trigger a micro-scroll to force status bar repaint on older iOS
    const y = window.scrollY;
    window.scrollTo(0, y === 0 ? 1 : 0);
    requestAnimationFrame(() => window.scrollTo(0, y));
  }, [theme]);

  function toggle() {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      localStorage.setItem("theme", next);
      return next;
    });
  }

  const safeAreaBg = theme === "dark" ? "#0a0a0a" : "#ffffff";

  return (
    <Ctx.Provider value={{ theme, toggle }}>
      <div aria-hidden style={{ position: "fixed", top: 0, left: 0, right: 0, height: "env(safe-area-inset-top, 0px)", background: safeAreaBg, zIndex: 9999, pointerEvents: "none" }} />
      <div aria-hidden style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: "env(safe-area-inset-bottom, 0px)", background: safeAreaBg, zIndex: 9999, pointerEvents: "none" }} />
      {children}
    </Ctx.Provider>
  );
}

export function useTheme() { return useContext(Ctx); }
