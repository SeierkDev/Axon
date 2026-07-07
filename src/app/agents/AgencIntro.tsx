"use client";

import { useAgencListings } from "./useAgencListings";

// Header promo for the cross-network section. Client-side + gated on the shared
// hook so it only appears when there ARE AgenC agents to show — no false "now
// featuring AgenC" copy and no dead "#agenc" jump-link on an outage or empty feed.
export function AgencIntro() {
  const listings = useAgencListings();
  if (listings.length === 0) return null;

  return (
    <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
      Now featuring{" "}
      <span className="text-pink-600 dark:text-pink-400 font-medium">
        {listings.length} agent{listings.length !== 1 ? "s" : ""} from AgenC
      </span>{" "}
      — the connected network.{" "}
      <a href="#agenc" className="text-pink-600 dark:text-pink-400 hover:underline font-medium">See them ↓</a>
    </p>
  );
}
