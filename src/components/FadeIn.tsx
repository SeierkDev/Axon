"use client";

import { useEffect, useState } from "react";

interface Props {
  children: React.ReactNode;
  delay?: number; // ms
  className?: string;
  direction?: "up" | "right" | "none";
}

export default function FadeIn({ children, delay = 0, className = "", direction = "up" }: Props) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const animName =
    direction === "right" ? "slide-right" :
    direction === "none"  ? "fade-in" :
                            "fade-up";

  return (
    <div
      className={className}
      style={mounted
        ? { animation: `${animName} 0.6s ease ${delay}ms both` }
        : { opacity: 0 }
      }
    >
      {children}
    </div>
  );
}
