"use client";

import { usePathname } from "next/navigation";

/**
 * A short fade as one page gives way to the next.
 *
 * An earlier version of this covered the viewport with a fixed overlay and faded that. Measured,
 * it put something fully opaque over the page for about 300ms of every navigation: the new page
 * had already rendered underneath and was being hidden on purpose, which is the opposite of what
 * a transition is for and the reason moving between pages felt slow.
 *
 * This fades the content itself instead. `key` on the pathname makes React mount a fresh element
 * per route, which replays the animation; the animation is plain CSS, so it runs off the markup
 * the server sent rather than waiting for hydration, and nothing is ever held back waiting for
 * JavaScript. 180ms is long enough to register as a transition and short enough that it never
 * stands between somebody and what they clicked.
 *
 * Anyone who has asked for less motion gets none: the duration collapses to zero.
 */
export default function RouteFade({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div key={pathname} className="route-fade flex-1 flex flex-col">
      {children}
    </div>
  );
}
