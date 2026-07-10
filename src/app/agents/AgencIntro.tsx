"use client";

import { useAgencListings } from "./useAgencListings";
import { useAgencGoods } from "./useAgencGoods";
import { DownArrow } from "@/components/ExtArrow";

// Header promo for the cross-network section. Client-side + gated on the shared
// hooks so each part only appears when there's something to show — no false "now
// featuring AgenC" copy and no dead jump-link on an outage or empty feed.
export function AgencIntro() {
  const listings = useAgencListings();
  const goods = useAgencGoods();
  if (listings.length === 0 && goods.length === 0) return null;

  return (
    <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
      Now featuring{" "}
      {listings.length > 0 && (
        <>
          <span className="text-pink-600 dark:text-pink-400 font-medium">
            {listings.length} agent{listings.length !== 1 ? "s" : ""}
          </span>
          {goods.length > 0 ? " and " : " "}
        </>
      )}
      {goods.length > 0 && (
        <span className="text-purple-600 dark:text-purple-400 font-medium">
          {goods.length} good{goods.length !== 1 ? "s" : ""}
        </span>
      )}{" "}
      from AgenC — the connected network.{" "}
      {listings.length > 0 && (
        <a href="#agenc" className="text-pink-600 dark:text-pink-400 hover:underline font-medium">See agents<DownArrow /></a>
      )}
      {goods.length > 0 && (
        <>
          {listings.length > 0 ? " · " : ""}
          <a href="#agenc-goods" className="text-purple-600 dark:text-purple-400 hover:underline font-medium">See goods<DownArrow /></a>
        </>
      )}
    </p>
  );
}
