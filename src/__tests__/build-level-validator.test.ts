import { describe, it, expect } from "vitest";
import {
  parseWorldDesign,
  parseLayoutBlocks,
  validateLayout,
  type ParsedLayout,
} from "@/lib/buildLevelValidator";

// An open 300x300 field with the item and exit in clear space — fully solvable.
const openField: ParsedLayout = {
  width: 300,
  height: 300,
  start: { x: 20, y: 20 },
  exit: { x: 260, y: 260 },
  walls: [],
  items: [{ x: 150, y: 150 }],
};

// Walls that fully enclose the region x212-288, y112-200 (no gaps).
const sealedBox = [
  { x: 200, y: 100, w: 100, h: 12 }, // top
  { x: 200, y: 200, w: 100, h: 12 }, // bottom
  { x: 200, y: 100, w: 12, h: 112 }, // left
  { x: 288, y: 100, w: 12, h: 112 }, // right
];

describe("validateLayout", () => {
  it("passes an open, fully-reachable layout", () => {
    expect(validateLayout(openField).ok).toBe(true);
  });

  it("flags a collectible sealed off behind walls", () => {
    const layout: ParsedLayout = {
      width: 300, height: 300,
      start: { x: 20, y: 20 },
      exit: { x: 40, y: 260 },
      walls: sealedBox,
      items: [{ x: 250, y: 150 }], // inside the sealed box
    };
    const res = validateLayout(layout);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/unreachable/i);
  });

  it("flags an exit sealed off behind walls", () => {
    const layout: ParsedLayout = {
      width: 300, height: 300,
      start: { x: 20, y: 20 },
      exit: { x: 250, y: 150 }, // inside the sealed box
      walls: sealedBox,
      items: [{ x: 40, y: 260 }],
    };
    const res = validateLayout(layout);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/exit.*unreachable/i);
  });

  it("flags an unwinnable level when the player spawns sealed in a room", () => {
    const layout: ParsedLayout = {
      width: 300, height: 300,
      start: { x: 250, y: 150 }, // spawn INSIDE the sealed box
      exit: { x: 40, y: 40 }, // outside — can never be reached
      walls: sealedBox,
      items: [],
    };
    expect(validateLayout(layout).ok).toBe(false);
  });

  it("flags a gap narrower than the player — the real collision box can't fit through", () => {
    // A full-height barrier split into top/bottom, leaving a 22px gap at y 88-110.
    const layout: ParsedLayout = {
      width: 400, height: 200,
      start: { x: 50, y: 100 }, // left chamber
      exit: { x: 350, y: 100 }, // right chamber, only reachable through the gap
      walls: [
        { x: 190, y: 0, w: 20, h: 88 },
        { x: 190, y: 110, w: 20, h: 90 },
      ],
      items: [],
    };
    // 24px player can't fit through 22px — exit is sealed off (the level-3 bug).
    expect(validateLayout(layout, 24).ok).toBe(false);
    // A smaller 20px hitbox fits, so the same map is beatable for it.
    expect(validateLayout(layout, 20).ok).toBe(true);
  });
});

describe("parseWorldDesign", () => {
  it("parses width, start, exit, walls, and item spawns", () => {
    const text = [
      "WORLD_DESIGN:",
      "Width: 900",
      "Height: 700",
      "Player Start: 80,80",
      "Exit: 810,610",
      "Wall: 40,40,220,20",
      "Wall: 40,40,20,200",
      "Item Spawn: red key | 460,130",
      "Item Spawn: blue key | 740,130",
    ].join("\n");
    const parsed = parseWorldDesign(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.width).toBe(900);
    expect(parsed!.start).toEqual({ x: 80, y: 80 });
    expect(parsed!.exit).toEqual({ x: 810, y: 610 });
    expect(parsed!.walls).toHaveLength(2);
    expect(parsed!.items).toHaveLength(2);
  });

  it("returns null when required fields are missing", () => {
    expect(parseWorldDesign("Width: 900\nWall: 1,2,3,4")).toBeNull();
  });
});

describe("parseLayoutBlocks", () => {
  it("extracts a single embedded layout from generated HTML", () => {
    const html =
      `<html><body><!--LAYOUT {"width":900,"height":700,"start":[80,80],"exit":[810,610],"walls":[[40,40,220,20]],"items":[[460,130]]} LAYOUT--></body></html>`;
    const levels = parseLayoutBlocks(html);
    expect(levels).toHaveLength(1);
    expect(levels[0].width).toBe(900);
    expect(levels[0].items).toEqual([{ x: 460, y: 130 }]);
  });

  it("extracts every level from a multi-level layout", () => {
    const html =
      `<!--LAYOUT {"levels":[` +
      `{"width":900,"height":700,"start":[80,80],"exit":[810,610],"walls":[[40,40,220,20]],"items":[[460,130]]},` +
      `{"width":900,"height":700,"start":[80,80],"exit":[810,610],"walls":[[100,100,200,20]],"items":[[500,500]]}` +
      `]} LAYOUT-->`;
    const levels = parseLayoutBlocks(html);
    expect(levels).toHaveLength(2);
    expect(levels[1].items).toEqual([{ x: 500, y: 500 }]);
  });

  it("returns empty when there is no layout block", () => {
    expect(parseLayoutBlocks("<html></html>")).toEqual([]);
  });
});
