// Deterministic "is this level actually beatable?" checker for Axon Build.
//
// LLMs are weak at authoring precise spatial geometry, so a generated dungeon
// often has unreachable keys, a sealed-off exit, or a spawn box with no way out.
// This module parses the structured layout the model produced and FLOOD-FILLS it
// from the player's spawn — exactly like a player walking around — then reports
// any key or the exit that can't be reached. The pipeline feeds those errors back
// to the model so it redraws until the map genuinely works. The model still
// authors every map; this only refuses to ship a broken one.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}
export interface ParsedLayout {
  width: number;
  height: number;
  start: Pt;
  exit: Pt;
  walls: Box[];
  items: Pt[]; // collectibles (keys etc.) that must be reachable
}
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function firstNum(text: string, re: RegExp): number | null {
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}
function firstPt(text: string, re: RegExp): Pt | null {
  const m = text.match(re);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

// Parse the model's WORLD_DESIGN block into a layout we can walk.
export function parseWorldDesign(text: string): ParsedLayout | null {
  const width = firstNum(text, /Width:\s*(\d+)/i);
  const height = firstNum(text, /Height:\s*(\d+)/i);
  const start = firstPt(text, /Player Start:\s*(\d+)\s*,\s*(\d+)/i);
  const exit = firstPt(text, /Exit:\s*(\d+)\s*,\s*(\d+)/i);
  if (width == null || height == null || !start || !exit) return null;

  const walls: Box[] = [];
  const wallRe = /Wall:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi;
  for (let m = wallRe.exec(text); m; m = wallRe.exec(text)) {
    walls.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
  }

  const items: Pt[] = [];
  const itemRe = /Item Spawn:[^|\n]*\|\s*(\d+)\s*,\s*(\d+)/gi;
  for (let m = itemRe.exec(text); m; m = itemRe.exec(text)) {
    items.push({ x: Number(m[1]), y: Number(m[2]) });
  }

  return { width, height, start, exit, walls, items };
}

interface RawLayout {
  width?: number;
  height?: number;
  start?: [number, number];
  exit?: [number, number];
  walls?: [number, number, number, number][];
  items?: [number, number][];
}

function fromRaw(j: RawLayout): ParsedLayout | null {
  if (!j.width || !j.height || !Array.isArray(j.start) || !Array.isArray(j.exit) || !Array.isArray(j.walls)) {
    return null;
  }
  return {
    width: j.width,
    height: j.height,
    start: { x: j.start[0], y: j.start[1] },
    exit: { x: j.exit[0], y: j.exit[1] },
    walls: j.walls.map((w) => ({ x: w[0], y: w[1], w: w[2], h: w[3] })),
    items: (j.items ?? []).map((p) => ({ x: p[0], y: p[1] })),
  };
}

// Parse the machine-readable layout(s) the coder embeds in the final HTML so we
// can re-check the ACTUAL geometry of the built game. Supports a single level:
//   <!--LAYOUT {"width":900,...,"walls":[...],"items":[...]} LAYOUT-->
// or every level of a multi-level game:
//   <!--LAYOUT {"levels":[{...},{...},{...}]} LAYOUT-->
// Returns one ParsedLayout per level (empty if absent/unparseable).
export function parseLayoutBlocks(html: string): ParsedLayout[] {
  const m = html.match(/LAYOUT\s*(\{[\s\S]*\})\s*LAYOUT/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[1]) as RawLayout & { levels?: RawLayout[] };
    if (Array.isArray(j.levels)) {
      return j.levels.map(fromRaw).filter((l): l is ParsedLayout => l !== null);
    }
    const single = fromRaw(j);
    return single ? [single] : [];
  } catch {
    return [];
  }
}

// Walk the layout from the spawn and report any key/exit that can't be reached.
// playerSize is the collision box; we use a slightly smaller effective size so a
// genuinely-passable corridor isn't false-flagged, only clearly blocked targets.
export function validateLayout(layout: ParsedLayout, playerSize = 24): ValidationResult {
  const { width, height, walls, start, exit, items } = layout;
  if (!width || !height || width > 4000 || height > 4000) return { ok: true, errors: [] };

  const errors: string[] = [];
  const cell = 8;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  // Model the SAME collision box the game uses (full playerSize). A smaller
  // "lenient" probe slips through gaps the real player can't — passing levels
  // that trap the player (e.g. a 20px gap for a 24px player). Soundness rule:
  // never report a target reachable unless the real-size player can actually get there.
  const size = Math.max(8, playerSize);

  const walkable = (c: number, r: number): boolean => {
    const x = c * cell;
    const y = r * cell;
    if (x < 0 || y < 0 || x + size > width || y + size > height) return false;
    for (const w of walls) {
      if (x < w.x + w.w && x + size > w.x && y < w.y + w.h && y + size > w.y) return false;
    }
    return true;
  };

  // Find a walkable starting cell at (or just around) the spawn point.
  let sc = Math.floor(start.x / cell);
  let sr = Math.floor(start.y / cell);
  if (!walkable(sc, sr)) {
    let found = false;
    for (let rad = 1; rad <= 6 && !found; rad++) {
      for (let dr = -rad; dr <= rad && !found; dr++) {
        for (let dc = -rad; dc <= rad && !found; dc++) {
          if (walkable(sc + dc, sr + dr)) { sc += dc; sr += dr; found = true; }
        }
      }
    }
    if (!found) {
      return { ok: false, errors: ["the player spawn is blocked or sealed inside a wall"] };
    }
  }

  // Flood-fill (BFS) all cells reachable from the spawn.
  const visited = new Uint8Array(cols * rows);
  const queue: number[] = [sr * cols + sc];
  visited[sr * cols + sc] = 1;
  const reachableCenters: Pt[] = [];
  while (queue.length) {
    const idx = queue.pop() as number;
    const c = idx % cols;
    const r = (idx - c) / cols;
    reachableCenters.push({ x: c * cell + size / 2, y: r * cell + size / 2 });
    const neighbors = [idx + 1, idx - 1, idx + cols, idx - cols];
    const cs = [c + 1, c - 1, c, c];
    for (let i = 0; i < 4; i++) {
      const nc = cs[i];
      const ni = neighbors[i];
      if (ni < 0 || ni >= cols * rows || visited[ni]) continue;
      const nr = (ni - nc) / cols;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (!walkable(nc, nr)) continue;
      visited[ni] = 1;
      queue.push(ni);
    }
  }

  const pickupR = playerSize + 16; // generous: collectible if the player can stand near it
  const reachable = (pt: Pt): boolean =>
    reachableCenters.some((v) => Math.hypot(v.x - pt.x, v.y - pt.y) <= pickupR);

  for (const it of items) {
    if (!reachable(it)) errors.push(`a collectible at (${it.x},${it.y}) is unreachable from the player start`);
  }
  if (!reachable(exit)) errors.push(`the exit at (${exit.x},${exit.y}) is unreachable from the player start`);

  return { ok: errors.length === 0, errors };
}
