"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [overlayKey, setOverlayKey] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOverlayKey((k) => k + 1);
  }, [pathname]);

  return (
    <>
      {children}
      <div
        key={overlayKey}
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: "white",
          zIndex: 9999,
          pointerEvents: "none",
          animation: "fade-out 0.3s ease forwards",
        }}
      />
    </>
  );
}
