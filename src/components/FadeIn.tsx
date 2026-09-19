interface Props {
  children: React.ReactNode;
  delay?: number; // ms
  className?: string;
  direction?: "up" | "right" | "none";
}

/**
 * The entrance animation for a block of content.
 *
 * It used to render `opacity: 0` and only apply the animation after mounting, which meant
 * server-rendered content stayed INVISIBLE until React hydrated. The markup had arrived and the
 * browser had painted it, and it was being hidden waiting for JavaScript — on a slow device that is
 * the difference between a page that appears at once and one that appears eventually.
 *
 * The animation is applied directly now. `both` fill mode holds the from-state before it starts, so
 * the visual is the same, minus the wait. It is no longer a client component either, so it costs
 * nothing in the bundle.
 */
export default function FadeIn({ children, delay = 0, className = "", direction = "up" }: Props) {
  const animName =
    direction === "right" ? "slide-right" :
    direction === "none"  ? "fade-in" :
                            "fade-up";

  return (
    <div className={className} style={{ animation: `${animName} 0.4s ease ${delay}ms both` }}>
      {children}
    </div>
  );
}
