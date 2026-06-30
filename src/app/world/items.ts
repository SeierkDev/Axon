// Phase 10: collectible items for Axon World minigames.
//
// Everything a visitor can win — fish and treasures from the ponds, the golden
// hen's egg, the ring-run trophy. Guests hold them in memory for the session;
// wallet users persist them via /api/world/inventory.

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface ItemDef {
  id: string;
  name: string;
  icon: string;
  rarity: Rarity;
  blurb: string;
  /** Eatable — the inventory shows an Eat button (small speed boost). */
  food?: boolean;
}

export const RARITY_COLOR: Record<Rarity, string> = {
  common: "#9ca3af",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#f59e0b",
};

export const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

const defs: ItemDef[] = [
  // Fishing — common
  { id: "minnow", name: "Minnow", icon: "🐟", rarity: "common", blurb: "A tiny silver flicker." },
  { id: "perch", name: "Perch", icon: "🐟", rarity: "common", blurb: "A pond regular." },
  { id: "carp", name: "Carp", icon: "🐟", rarity: "common", blurb: "Big, lazy, reliable." },
  { id: "old_boot", name: "Old Boot", icon: "👢", rarity: "common", blurb: "Someone's lost sole." },
  // Fishing — rare
  { id: "bass", name: "Bass", icon: "🐠", rarity: "rare", blurb: "Put up a proper fight." },
  { id: "catfish", name: "Catfish", icon: "🐡", rarity: "rare", blurb: "Whiskers and attitude." },
  { id: "pearl", name: "Pearl", icon: "🦪", rarity: "rare", blurb: "Something shiny in the silt." },
  { id: "bottle_message", name: "Message in a Bottle", icon: "📜", rarity: "rare", blurb: "A note from another operator." },
  // Fishing — epic
  { id: "golden_koi", name: "Golden Koi", icon: "🎏", rarity: "epic", blurb: "Glimmers even at dusk." },
  { id: "ancient_coin", name: "Ancient Coin", icon: "🪙", rarity: "epic", blurb: "Minted before the genesis epoch." },
  { id: "teal_crystal", name: "Teal Crystal", icon: "💎", rarity: "epic", blurb: "Hums faintly, like the monument." },
  // Fishing — legendary
  { id: "golden_fish", name: "Golden Fish", icon: "✨", rarity: "legendary", blurb: "The pond's oldest secret." },
  { id: "axon_relic", name: "Axon Relic", icon: "⚙️", rarity: "legendary", blurb: "A gear from the first machine." },
  // Minigame prizes
  { id: "golden_egg", name: "Golden Egg", icon: "🥚", rarity: "epic", blurb: "Caught the golden hen!" },
  { id: "ring_trophy", name: "Runner's Trophy", icon: "🏆", rarity: "epic", blurb: "A new Ring Run best time." },
  // Foraging — eatable (Eat gives a short speed boost)
  { id: "apple", name: "Apple", icon: "🍎", rarity: "common", blurb: "Crisp, straight from the orchard.", food: true },
  { id: "berries", name: "Berries", icon: "🫐", rarity: "common", blurb: "Sweet wild berries.", food: true },
  { id: "golden_berry", name: "Golden Berry", icon: "✨", rarity: "epic", blurb: "Glows faintly. Tastes like sunshine.", food: true },
  // Digging
  { id: "rusty_gear", name: "Rusty Gear", icon: "🔩", rarity: "common", blurb: "Dug up from the old network." },
];

export const ITEMS: Record<string, ItemDef> = Object.fromEntries(defs.map((d) => [d.id, d]));

// Weighted fishing loot — common 62%, rare 26%, epic 9.5%, legendary 2.5%.
const LOOT: { id: string; w: number }[] = [
  { id: "minnow", w: 18 }, { id: "perch", w: 16 }, { id: "carp", w: 15 }, { id: "old_boot", w: 13 },
  { id: "bass", w: 8 }, { id: "catfish", w: 7 }, { id: "pearl", w: 6 }, { id: "bottle_message", w: 5 },
  { id: "golden_koi", w: 4 }, { id: "ancient_coin", w: 3.2 }, { id: "teal_crystal", w: 2.3 },
  { id: "golden_fish", w: 1.5 }, { id: "axon_relic", w: 1 },
];
const LOOT_TOTAL = LOOT.reduce((s, l) => s + l.w, 0);

export function rollCatch(rand: () => number = Math.random): ItemDef {
  let roll = rand() * LOOT_TOTAL;
  for (const l of LOOT) {
    roll -= l.w;
    if (roll <= 0) return ITEMS[l.id];
  }
  return ITEMS.minnow;
}

// Daily gift-chest loot at active agents' houses — friendlier odds than the
// pond (it's a thank-you-for-visiting, not a grind): mostly snacks and scrap,
// a real shot at something rare, never a legendary.
const GIFTS: { id: string; w: number }[] = [
  { id: "apple", w: 22 }, { id: "berries", w: 22 }, { id: "rusty_gear", w: 15 }, { id: "minnow", w: 12 },
  { id: "pearl", w: 9 }, { id: "bottle_message", w: 8 },
  { id: "ancient_coin", w: 5 }, { id: "teal_crystal", w: 4 }, { id: "golden_berry", w: 3 },
];
const GIFTS_TOTAL = GIFTS.reduce((s, l) => s + l.w, 0);

export function rollGift(rand: () => number = Math.random): ItemDef {
  let roll = rand() * GIFTS_TOTAL;
  for (const l of GIFTS) {
    roll -= l.w;
    if (roll <= 0) return ITEMS[l.id];
  }
  return ITEMS.apple;
}

// Sort order for the inventory panel — flashiest first.
export const RARITY_ORDER: Rarity[] = ["legendary", "epic", "rare", "common"];
