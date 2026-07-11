// Axon World Arcade — arena layouts + platform physics for the minigames.
//
// PURE module (no three.js, no React) so the geometry is unit-testable: the
// test suite proves every hop of every course is humanly makeable with the
// world's jump physics before anyone rage-quits at an impossible gap. The
// renderer (arcade.tsx) and the player controller (World3D) both consume this
// single source of truth, so what you see is exactly what you collide with.
//
// Minigames are entered from the MINIGAMES overlay (top-right tab in the
// world) — not walked to. Each mode has its own arena clearing far outside
// the city (inside the presence server's ±600 clamp), ringed by the same
// mountain country as the city so no edge ever reads as a void.
//
// Modes:
//   climb    — "Sky Climb":    100 platforms winding OUT into the sky on their
//                               own paths around a straight stone spire
//   gauntlet — "The Gauntlet": a U-shaped, ~370m double-lane obstacle course —
//                               out on the south lane, hairpin, home on the north
//   arena    — "Zombie Waves": survive the horde — six weapons, mags, drops,
//                               a mystery box, and waves that RUN at you later

export interface Plat {
  x: number; // centre, world coords
  z: number;
  y: number; // top surface height
  hw: number; // half-width (x)
  hd: number; // half-depth (z)
  /**
   * Blocks at every height instead of only below `y - STEP_UP`.
   *
   * The height window exists so you can hop onto things. On a boundary hedge
   * that is a hole: a flat-ground jump peaks at 1.41m and a 1.9m hedge stops
   * colliding at 1.35m, so you clear it by 6cm and land outside the course.
   * Anything you are meant to go *around* rather than *over* sets this.
   */
  noJump?: boolean;
}

export interface RunBox {
  x: number;
  z: number;
  hw: number;
  hd: number;
  minH: number; // must be at (or above) this height to count
}

export interface ArenaDef {
  cx: number;
  cz: number;
  r: number; // walkable clearing radius (mountains ring just outside)
  spawn: { x: number; z: number };
}

// ── Movement facts (mirrors World3D constants — asserted equal in the test) ──
export const STEP_UP = 0.55; // max ledge you can walk/land up without a jump
const PLAYER_R = 0.7;
const GRACE = 0.35; // landing forgiveness at platform edges
const SLAB = 0.6; // platform slab thickness (visual + side-collision band)

// Deterministic PRNG — layouts must be identical on every client and in CI.
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Arenas (one clearing per mode; all inside the ±600 presence clamp) ───────
export const ARENAS: Record<"climb" | "gauntlet" | "arena", ArenaDef> = {
  climb: { cx: -552, cz: 552, r: 46, spawn: { x: -552, z: 552 + 15 } },
  gauntlet: { cx: 500, cz: 500, r: 96, spawn: { x: 500 - 90, z: 500 - 12 } },
  arena: { cx: -536, cz: -536, r: 62, spawn: { x: -536, z: -536 + 6 } },
};

export type ArcadeModeId = keyof typeof ARENAS;

// ── Mode 1: Sky Climb ─────────────────────────────────────────────────────────
// 100 platforms, ~95m — a LONG, hard run. The route is not a corkscrew: every
// ~17 hops it strikes far out from the tower (up to ~28m) on its own winding
// path before folding back in. Every 7th hop is a sprint-jump; ledges shrink
// with altitude; rest knolls every 10.
export type PlatKind = "boulder" | "grass" | "hay" | "log" | "crate" | "barrel" | "cart";
export interface ClimbPlat extends Plat {
  kind: PlatKind;
  rest: boolean;
  /** Gives way ~0.8s after you stand on it — keep moving. Never a rest or sprint pad. */
  crumble?: boolean;
}

// ── Daily variation ───────────────────────────────────────────────────────────
// The routes breathe: a new UTC day = a new seed, so today's climb line and
// sweeper timing differ from yesterday's. Deterministic from the date alone —
// every client (and the server) derives the identical layout.
export function dailySeed(offsetDays = 0): number {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export const CLIMB_COUNT = 100;
const KINDS: PlatKind[] = ["boulder", "grass", "hay", "log", "crate", "barrel", "grass", "boulder", "cart", "log"];
// The excursion profile over a 17-hop cycle: how far beyond the base radius
// the route swings. A long sustained arc WAY out from the tower (up to ~26m
// past the base) and back — so the route strikes out on its own paths instead
// of hugging the spire and corkscrewing around it every hop.
const EXCURSION: number[] = [0, 0, 3, 8, 14, 20, 25, 27, 27, 25, 20, 14, 8, 3, 0, 0, 0];

function makeClimb(seed: number): ClimbPlat[] {
  const g = ARENAS.climb;
  const rnd = mulberry(seed);
  const plats: ClimbPlat[] = [];
  let a = 0.4;
  let y = 1.0;
  for (let i = 0; i < CLIMB_COUNT; i++) {
    const rest = i > 0 && i % 10 === 0;
    const phase = i % 17;
    const excursion = EXCURSION[phase];
    const inExcursion = excursion > 0 || EXCURSION[(i + 16) % 17] > 0; // in or exiting
    // sprint sections: every 7th hop is a LOW rise but a WIDE swing — never
    // stacked on an excursion transition
    const sprint = i % 7 === 3 && !rest && !inExcursion;
    // rises pushed just under the reachability cap (1.10m); the real difficulty
    // now comes from the WIDER horizontal gaps below — the hops were too gentle.
    if (i > 0) y += rest ? 0.78 : sprint ? 0.86 : 0.92 + (i % 3) * 0.09;
    // less corkscrew: a gentler base angular step, and out wide it shrinks hard
    // (same arc length costs less angle at a bigger radius) so the route reads
    // as striking outward, not circling the tower.
    a += i === 0 ? 0 : ((sprint ? 0.98 : 0.55) * (inExcursion ? 0.36 : 1)) + (rnd() - 0.5) * 0.07;
    // smaller ledges than before — this is meant to be earned
    const half = rest ? 2.8 : Math.max(1.15, 1.55 - i * 0.003) + (i % 4 === 1 ? 0.25 : 0);
    // base sits further off the tower, and the excursion carries it WAY out
    const rRaw = (sprint ? 12.5 : 10.5 + Math.sin(i * 0.71) * 3.4) + excursion;
    const r = Math.max(rRaw, half + 3.6);
    plats.push({
      x: g.cx + Math.cos(a) * r,
      z: g.cz + Math.sin(a) * r,
      y,
      hw: half,
      hd: half,
      kind: rest ? "grass" : KINDS[i % KINDS.length],
      rest,
      // ~1 in 9 mid-tower ledges gives way under your feet — camping is not a
      // strategy. Never a rest pad, never a sprint pad, never the first stretch.
      crumble: !rest && !sprint && i > 12 && i % 9 === 4,
    });
  }
  return plats;
}

// Movement constants mirrored from World3D's controller (and the CI test) — the
// generator VALIDATES each day's course against them with margins strictly
// tighter than the test's, so a jittered seed can never ship an unclimbable day.
const JUMP_V = 7.5;
const GRAVITY = 20;
const RUN_SPEED = 16;
const JUMP_APEX = (JUMP_V * JUMP_V) / (2 * GRAVITY);

export function climbCourseSafe(plats: ClimbPlat[]): boolean {
  // EXACTLY the CI reachability margins (arcade.test.ts) — the design pushes
  // rises to the 1.10m cap on purpose, so any stricter margin rejects every
  // course; any looser one could ship a day the test (and a player) can't beat.
  if (plats[0].y > JUMP_APEX - 0.2) return false;
  for (let i = 1; i < plats.length; i++) {
    const p = plats[i - 1], q = plats[i];
    const rise = q.y - p.y;
    if (rise > JUMP_APEX - 0.3 + 1e-9) return false;
    const tLand = (JUMP_V + Math.sqrt(JUMP_V * JUMP_V - 2 * GRAVITY * Math.max(0, rise))) / GRAVITY;
    const reach = RUN_SPEED * tLand;
    const edgeGap = Math.hypot(q.x - p.x, q.z - p.z) - Math.min(p.hw, p.hd) - Math.min(q.hw, q.hd);
    if (edgeGap >= reach - 0.5) return false;
  }
  return true;
}

/** Today's course: the daily seed, advanced deterministically until it
 *  validates (all clients converge on the same fallback chain). */
export function makeClimbForDay(seed: number): ClimbPlat[] {
  for (let k = 0; k < 50; k++) {
    const c = makeClimb(seed + k);
    if (climbCourseSafe(c)) return c;
  }
  return makeClimb(0xa11ce4); // the proven original — unreachable in practice
}

export const CLIMB: ClimbPlat[] = makeClimbForDay(dailySeed());
/** Runtime mutator for the crumble system — the module that OWNS the course
 *  array does the writing (collider height is read live by the physics). */
export function setClimbPlatY(index: number, y: number): void {
  CLIMB[index].y = y;
}
export const SUMMIT: ClimbPlat = CLIMB[CLIMB.length - 1];
// Quarter-height milestones — the climb's split gates (25/50/75% of the tower).
export const CLIMB_QUARTERS: number[] = [0.25, 0.5, 0.75].map((k) => SUMMIT.y * k);

// ── Springboards: three risk/reward shortcuts on the daily route ─────────────
// A small spring circle on the EDGE of three mid-route platforms (never a
// crumble ledge): step onto it and it launches you high enough to skip a couple
// of hops — if you can steer the landing. Offset to the platform's rim so
// stepping on it is a CHOICE, not a trap on the racing line.
function firstSolidFrom(i: number): number {
  let j = i;
  while (CLIMB[j]?.crumble) j++;
  return Math.min(j, CLIMB_COUNT - 2);
}
export const CLIMB_SPRINGS: { x: number; z: number; y: number; r: number; v: number }[] =
  [22, 47, 71].map(firstSolidFrom).map((i) => {
    const p = CLIMB[i];
    return { x: p.x + p.hw * 0.55, z: p.z, y: p.y, r: 0.95, v: 2.45 };
  });

// ── Mode 2: The Gauntlet (S-course — three legs, two hairpins) ──────────────
// OUT on the south lane (west → east), around the EAST hairpin, BACK on the
// middle lane (east → west), around the WEST hairpin, then the north lane runs
// west → east to the finish. Full-length divider hedges separate the legs and
// outer hedges + end caps seal the course — the only opening is the mouth
// behind the start gate. Water and sweeper arms send you back to the LAST
// CHECKPOINT YOU TOUCHED — checkpoints are ordered, so there are no shortcuts.
const G = ARENAS.gauntlet;
export const LANE_HALF = 5.2; // lane half-width
export const LANE_OFF = 16; // lane centreline offset (legs at -OFF, 0, +OFF)
export const LANE_LEN = 500; // total course path length, roughly

const ZA = G.cz - LANE_OFF; // south lane (leg 1, west → east)
const ZB = G.cz; // middle lane (leg 2, east → west)
const ZC = G.cz + LANE_OFF; // north lane (leg 3, west → east — the finish leg)

// The corridor each leg actually occupies, measured from the leg's centreline
// out to the solid faces either side. The lanes are 10.4m wide but sit in
// corridors up to 14.8m wide, and an obstacle sized to the *lane* leaves a
// 3.4m strip of open grass beside it — enough to run the whole course without
// touching a single hurdle. Everything that is meant to stop you is built from
// these bounds instead, so it spans wall to wall.
const OUTER_PAD = 1.7, OUTER_HD = 0.5, DIV_Z = 8, DIV_HD = 0.6;
const OUTER_FACE = LANE_HALF + OUTER_PAD - OUTER_HD; // 6.4 — outer hedge, inner face
const DIV_INNER = DIV_Z - DIV_HD; // 7.4 — divider face, from the arena centreline
const DIV_FROM_LANE = LANE_OFF - DIV_Z - DIV_HD; // 7.4 — divider face, from an outer lane
const CORRIDOR = {
  A: { lo: -OUTER_FACE, hi: DIV_FROM_LANE }, // outer hedge → divider A/B
  B: { lo: -DIV_INNER, hi: DIV_INNER }, // divider → divider
  C: { lo: -DIV_FROM_LANE, hi: OUTER_FACE }, // divider B/C → outer hedge
} as const;

/** A blocker that spans its whole corridor — no way past but over or through. */
function fullBlock(x: number, laneZ: number, corr: { lo: number; hi: number }, y: number, hw: number): Plat {
  return { x, z: laneZ + (corr.lo + corr.hi) / 2, y, hw, hd: (corr.hi - corr.lo) / 2 };
}

/**
 * One tooth of a slalom: flush against one corridor wall, leaving `gap` metres
 * open on the other side. Sized off the corridor so the gap is the only way
 * through — a tooth sized off the lane leaves a second gap nobody intended.
 */
function slalomWall(
  x: number, laneZ: number, corr: { lo: number; hi: number },
  side: -1 | 1, y: number, hw: number, gap: number,
): Plat {
  const width = corr.hi - corr.lo - gap;
  const lo = side < 0 ? corr.lo : corr.hi - width;
  return { x, z: laneZ + lo + width / 2, y, hw, hd: width / 2, noJump: true };
}

const SLALOM_GAP = 4.3; // the racing line through a slalom, unchanged

function makeGauntlet(): { plats: Plat[]; walls: Plat[]; stairs: Plat[] } {
  const plats: Plat[] = [];
  const walls: Plat[] = [];
  const stairs: Plat[] = [];

  // ═ Leg 1 (south lane, west → east) ═
  for (const dx of [-80, -75, -70, -65]) {
    plats.push(fullBlock(G.cx + dx, ZA, CORRIDOR.A, 1.15, 0.35));
  }
  // pond one — five stones
  for (let i = 0; i < 5; i++) {
    plats.push({ x: G.cx - 58 + i * 3.5, z: ZA + Math.sin(i * 2.1) * 1.7, y: 0.5, hw: 0.8, hd: 0.8 });
  }
  // wall slalom ×6
  for (let i = 0; i < 6; i++) {
    walls.push(slalomWall(G.cx - 36 + i * 3.6, ZA, CORRIDOR.A, i % 2 === 0 ? -1 : 1, 1.9, 0.4, SLALOM_GAP));
  }
  // (twin sweepers guard the run-up to rampart one — see GAUNTLET_SWEEPERS)
  // rampart one — stairs up, over, down
  walls.push(fullBlock(G.cx + 6, ZA, CORRIDOR.A, 2.2, 0.6));
  stairs.push({ x: G.cx + 1.5, z: ZA, y: 1.1, hw: 1.2, hd: 2.4 });
  stairs.push({ x: G.cx + 6, z: ZA, y: 2.2, hw: 1.6, hd: 2.4 });
  stairs.push({ x: G.cx + 10.5, z: ZA, y: 1.1, hw: 1.2, hd: 2.4 });
  // the long pond — six zig-zag stones
  for (let i = 0; i < 6; i++) {
    plats.push({ x: G.cx + 16 + i * 3.4, z: ZA + Math.sin(i * 1.9) * 2.4, y: 0.5, hw: 0.8, hd: 0.8 });
  }
  for (const dx of [42, 47, 52]) {
    plats.push(fullBlock(G.cx + dx, ZA, CORRIDOR.A, 1.15, 0.35));
  }

  // ═ Leg 2 (middle lane, east → west) ═
  for (const dx of [52, 47, 42]) {
    plats.push(fullBlock(G.cx + dx, ZB, CORRIDOR.B, 1.15, 0.35));
  }
  // pond three — five stones
  for (let i = 0; i < 5; i++) {
    plats.push({ x: G.cx + 34 - i * 3.4, z: ZB + Math.sin(i * 2.3) * 1.8, y: 0.5, hw: 0.8, hd: 0.8 });
  }
  // the tight slalom ×7
  for (let i = 0; i < 7; i++) {
    walls.push(slalomWall(G.cx + 10 - i * 3.3, ZB, CORRIDOR.B, i % 2 === 0 ? -1 : 1, 1.9, 0.4, SLALOM_GAP));
  }
  // rampart two
  walls.push(fullBlock(G.cx - 30, ZB, CORRIDOR.B, 2.2, 0.6));
  stairs.push({ x: G.cx - 34.5, z: ZB, y: 1.1, hw: 1.2, hd: 2.4 });
  stairs.push({ x: G.cx - 30, z: ZB, y: 2.2, hw: 1.6, hd: 2.4 });
  stairs.push({ x: G.cx - 25.5, z: ZB, y: 1.1, hw: 1.2, hd: 2.4 });
  // pond four — the tired-legs test
  for (let i = 0; i < 4; i++) {
    plats.push({ x: G.cx - 40 - i * 3.6, z: ZB + Math.sin(i * 2.6) * 1.7, y: 0.5, hw: 0.8, hd: 0.8 });
  }
  for (const dx of [-60, -65, -70]) {
    plats.push(fullBlock(G.cx + dx, ZB, CORRIDOR.B, 1.15, 0.35));
  }

  // ═ Leg 3 (north lane, west → east — sprint for the line) ═
  for (const dx of [-70, -65, -60]) {
    plats.push(fullBlock(G.cx + dx, ZC, CORRIDOR.C, 1.15, 0.35));
  }
  // pond five — five stones
  for (let i = 0; i < 5; i++) {
    plats.push({ x: G.cx - 52 + i * 3.5, z: ZC + Math.sin(i * 2.0) * 1.7, y: 0.5, hw: 0.8, hd: 0.8 });
  }
  // slalom ×5
  for (let i = 0; i < 5; i++) {
    walls.push(slalomWall(G.cx - 30 + i * 3.5, ZC, CORRIDOR.C, i % 2 === 0 ? 1 : -1, 1.9, 0.4, SLALOM_GAP));
  }
  // rampart three
  walls.push(fullBlock(G.cx - 6, ZC, CORRIDOR.C, 2.2, 0.6));
  stairs.push({ x: G.cx - 10.5, z: ZC, y: 1.1, hw: 1.2, hd: 2.4 });
  stairs.push({ x: G.cx - 6, z: ZC, y: 2.2, hw: 1.6, hd: 2.4 });
  stairs.push({ x: G.cx - 1.5, z: ZC, y: 1.1, hw: 1.2, hd: 2.4 });
  // the last pond — six stones
  for (let i = 0; i < 6; i++) {
    plats.push({ x: G.cx + 20 + i * 3.5, z: ZC + Math.sin(i * 1.8) * 2.2, y: 0.5, hw: 0.8, hd: 0.8 });
  }
  for (const dx of [46, 51, 56]) {
    plats.push(fullBlock(G.cx + dx, ZC, CORRIDOR.C, 1.15, 0.35));
  }

  return { plats, walls, stairs };
}

// Corridor hedges: outer walls, the two divider hedges (each stops short at its
// hairpin end), and the end caps. The ONLY opening is the mouth behind the
// start gate (the user asked for no wall at your back on the start line).
function makeSideWalls(): Plat[] {
  const walls: Plat[] = [];
  for (let x = -87.5; x <= 87.5; x += 12.5) {
    walls.push({ x: G.cx + x, z: ZA - (LANE_HALF + OUTER_PAD), y: 1.9, hw: 6.4, hd: OUTER_HD, noJump: true }); // south outer
    walls.push({ x: G.cx + x, z: ZC + (LANE_HALF + OUTER_PAD), y: 1.9, hw: 6.4, hd: OUTER_HD, noJump: true }); // north outer
  }
  // divider A/B — from the west wall to the EAST hairpin mouth
  for (let x = -90; x <= 55; x += 12.6) {
    walls.push({ x: G.cx + x, z: G.cz - DIV_Z, y: 1.9, hw: 6.5, hd: DIV_HD, noJump: true });
  }
  // divider B/C — from the WEST hairpin mouth to the east wall
  for (let x = 90; x >= -55; x -= 12.6) {
    walls.push({ x: G.cx + x, z: G.cz + DIV_Z, y: 1.9, hw: 6.5, hd: DIV_HD, noJump: true });
  }
  // east cap — seals the WHOLE east end, corner to corner (no walk-around)
  for (let z = -24; z <= 24; z += 6) {
    walls.push({ x: G.cx + 92, z: G.cz + z, y: 1.9, hw: 0.5, hd: 3.6, noJump: true });
  }
  // west cap — seals the WHOLE west end too. The course is a fully closed box;
  // you spawn inside at the start gate, so there's no reason to leave it, and
  // no gap on either side to run around the obstacles (the old open mouth on the
  // south/right was the cheat — you could walk through start and straight down
  // the outside). Sealed corner to corner now.
  for (let z = -24; z <= 24; z += 6) {
    walls.push({ x: G.cx - 92, z: G.cz + z, y: 1.9, hw: 0.5, hd: 3.6, noJump: true });
  }
  return walls;
}

const gauntletParts = makeGauntlet();
export const GAUNTLET_SIDEWALLS: Plat[] = makeSideWalls();
export const GAUNTLET_STAIRS: Plat[] = gauntletParts.stairs;
export const GAUNTLET_PLATS: Plat[] = [...gauntletParts.plats, ...gauntletParts.walls, ...gauntletParts.stairs, ...GAUNTLET_SIDEWALLS];
export const GAUNTLET_STONES: Plat[] = gauntletParts.plats.filter((p) => p.y === 0.5);
export const GAUNTLET_HURDLES: Plat[] = gauntletParts.plats.filter((p) => p.y === 1.15);
export const GAUNTLET_WALLS: Plat[] = gauntletParts.walls;
// Out of the corridor mid-course → back to the last checkpoint.
//
// Sits ON the outer hedge, not past it. Leave a margin beyond the hedge and you
// leave a lane of grass that is outside the course but still "in bounds" — land
// there and you can run the whole leg on the green without touching an
// obstacle. The hedges are unjumpable now, so this is the backstop rather than
// the defence, but a backstop with a gap in it is not one.
export const GAUNTLET_LANE_OOB = { x1: G.cx - 90, x2: G.cx + 90, halfZ: LANE_OFF + LANE_HALF + OUTER_PAD };

export const GAUNTLET_START: RunBox = { x: G.cx - 86, z: ZA, hw: 1.0, hd: LANE_HALF, minH: 0 };
export const GAUNTLET_FINISH: RunBox = { x: G.cx + 86, z: ZC, hw: 1.2, hd: LANE_HALF, minH: 0 };
// The two hairpin apron centres (also the turn-arm pivots — see sweepers).
export const GAUNTLET_TURNS = [
  { x: G.cx + 70, z: G.cz - 8 }, // east: leg 1 → leg 2
  { x: G.cx - 80, z: G.cz + 8 }, // west: leg 2 → leg 3 (past leg 2's last hurdles)
];
// ORDERED checkpoints — touched in sequence (within ~6m); resets return to the
// last one touched, so the S cannot be short-cut. The hairpin checkpoints sit
// INSIDE the turn arms' sweep: the turn cannot be waited out from safety.
export const GAUNTLET_CHECKPOINTS: { x: number; z: number }[] = [
  { x: G.cx - 86, z: ZA }, // 0: the start line
  { x: G.cx - 42, z: ZA }, // after pond one
  { x: G.cx - 20, z: ZA }, // after the slalom
  { x: G.cx + 13, z: ZA }, // after rampart one
  { x: G.cx + 38, z: ZA }, // after the long pond
  { x: G.cx + 58, z: ZA }, // leg 1 exit
  { x: G.cx + 72, z: G.cz - 8 }, // EAST hairpin — inside the arm's sweep
  { x: G.cx + 56, z: ZB }, // leg 2 entry
  { x: G.cx + 16, z: ZB }, // after pond three
  { x: G.cx - 11, z: ZB }, // after the tight slalom
  { x: G.cx - 37, z: ZB }, // after rampart two
  { x: G.cx - 56, z: ZB }, // after pond four
  { x: G.cx - 78, z: G.cz + 8 }, // WEST hairpin — inside the arm's sweep
  { x: G.cx - 56, z: ZC }, // leg 3 entry
  { x: G.cx - 33, z: ZC }, // after pond five
  { x: G.cx - 13, z: ZC }, // after the slalom
  { x: G.cx + 14, z: ZC }, // after rampart three
  { x: G.cx + 42, z: ZC }, // after the last pond
];
// Reset zones: the six ponds.
export const GAUNTLET_PONDS = [
  { x1: G.cx - 60, x2: G.cx - 42, z1: ZA + CORRIDOR.A.lo, z2: ZA + CORRIDOR.A.hi },
  { x1: G.cx + 15, x2: G.cx + 34.8, z1: ZA + CORRIDOR.A.lo, z2: ZA + CORRIDOR.A.hi },
  { x1: G.cx + 19.5, x2: G.cx + 35, z1: ZB + CORRIDOR.B.lo, z2: ZB + CORRIDOR.B.hi },
  { x1: G.cx - 52, x2: G.cx - 39, z1: ZB + CORRIDOR.B.lo, z2: ZB + CORRIDOR.B.hi },
  { x1: G.cx - 53.5, x2: G.cx - 37, z1: ZC + CORRIDOR.C.lo, z2: ZC + CORRIDOR.C.hi },
  { x1: G.cx + 19, x2: G.cx + 38.5, z1: ZC + CORRIDOR.C.lo, z2: ZC + CORRIDOR.C.hi },
];
// ── Speed pads: boost strips on the clean racing lines ───────────────────────
// One per leg, placed just past a checkpoint on a pond-free stretch — hit the
// line and the pad rewards it with a burst of pace. Grounded-only; the arrows
// point the leg's travel direction.
export const GAUNTLET_SPEED_PADS: { x: number; z: number; hw: number; hd: number; dir: 1 | -1 }[] = [
  { x: G.cx - 30, z: ZA, hw: 3.4, hd: 1.7, dir: 1 }, // leg 1, after pond one
  { x: G.cx + 6, z: ZB, hw: 3.4, hd: 1.7, dir: -1 }, // leg 2, after the hairpin checkpoint
  { x: G.cx - 26, z: ZC, hw: 3.4, hd: 1.7, dir: 1 }, // leg 3, the run for home
];
export const SPEED_PAD_BOOST = 1.38;

// Spinning sweeper arms (time-parametric): angle = t * w + phase. The two big
// r-7 arms ARE the hairpins: their pivots sit at the turn apron centres and
// their sweep covers the whole turning line — you time the turn or you reset.
export const GAUNTLET_SWEEPERS: { cx: number; cz: number; r: number; w: number; phase: number }[] = [
  // leg 1: pair between the slalom and rampart one
  { cx: G.cx - 12, cz: ZA - 1.6, r: 3.4, w: 1.6, phase: 0 },
  { cx: G.cx - 7, cz: ZA + 1.6, r: 3.4, w: -1.9, phase: 2.1 },
  // THE EAST HAIRPIN
  { cx: G.cx + 70, cz: G.cz - 8, r: 7, w: 1.15, phase: 0.5 },
  // leg 2: the corridor before rampart two
  { cx: G.cx - 16, cz: ZB - 1.4, r: 2.8, w: 2.2, phase: 0.7 },
  { cx: G.cx - 21, cz: ZB + 1.4, r: 2.8, w: -2.4, phase: 1.9 },
  // THE WEST HAIRPIN
  { cx: G.cx - 80, cz: G.cz + 8, r: 7, w: -1.2, phase: 2.6 },
  // leg 3: pair after rampart three
  { cx: G.cx + 5, cz: ZC - 1.5, r: 3.0, w: 2.3, phase: 1.1 },
  { cx: G.cx + 10, cz: ZC + 1.5, r: 3.0, w: -2.1, phase: 0.3 },
];
// Daily hazard timing: phases (and ±10% speed) reshuffle each UTC day. Both the
// renderer and the hazard check read THIS array, so visual == hitbox holds.
{
  const dr = mulberry(dailySeed() ^ 0x5eed);
  for (const s of GAUNTLET_SWEEPERS) {
    s.phase = (s.phase + dr() * Math.PI * 2) % (Math.PI * 2);
    s.w *= 0.9 + dr() * 0.2;
  }
}

// ── The stompers: vertical crushers on the straights ─────────────────────────
// A second hazard archetype: pistons that hang over the lane and slam down on a
// fixed cycle. Same contract as the sweepers — one parametric height function
// shared by the renderer AND the hazard check, so what crushes you is exactly
// what you saw. Placed programmatically in gaps the generator left free.
export interface Stomper { x: number; z: number; period: number; phase: number }
export const GAUNTLET_STOMPERS: Stomper[] = (() => {
  const lanes = [ZA, ZB, ZC];
  const out: Stomper[] = [];
  const occupied = (x: number, z: number): boolean => {
    for (const p of [...gauntletParts.plats, ...gauntletParts.walls]) {
      if (Math.abs(p.z - z) < LANE_HALF + 1 && Math.abs(p.x - x) < p.hw + 3.4) return true;
    }
    for (const pond of GAUNTLET_PONDS) {
      if (z > pond.z1 - 2 && z < pond.z2 + 2 && x > pond.x1 - 3.4 && x < pond.x2 + 3.4) return true;
    }
    for (const s of GAUNTLET_SWEEPERS) {
      if (Math.hypot(s.cx - x, s.cz - z) < s.r + 4) return true;
    }
    return false;
  };
  for (let li = 0; li < lanes.length; li++) {
    const z = lanes[li];
    // scan from mid-course outward so stompers land on the open straights
    for (const x0 of [10, -6, 26, -26, 42, -44, 56]) {
      const x = G.cx + x0 + li * 4; // stagger per lane so they don't align
      if (!occupied(x, z)) {
        out.push({ x, z, period: 2.4 + li * 0.45, phase: li * 0.9 });
        break;
      }
    }
  }
  return out;
})();

/** The piston head's height at time t (seconds) — shared by render + hazard. */
export function stomperHeadY(s: Stomper, t: number): number {
  const c = ((t + s.phase) / s.period) % 1;
  if (c < 0.66) return 3.2; // hanging high — safe to pass
  if (c < 0.74) return 3.2 - ((c - 0.66) / 0.08) * 2.75; // the SLAM
  if (c < 0.9) return 0.45; // planted on the deck
  return 0.45 + ((c - 0.9) / 0.1) * 2.75; // winching back up
}

// ── Mode 3: Zombie Waves ──────────────────────────────────────────────────────
// A PROPER graveyard: a stone crypt at the heart with a memorial obelisk, two
// ordered grave fields, ruined walls and crates for cover, the barn, the
// walk-in chapel — and a little SHED you can duck into when the horde presses.
const F = ARENAS.arena;

export const ZOMBIE_CRYPT = { x: F.cx, z: F.cz - 8 };
export const ZOMBIE_OBELISK = { x: F.cx, z: F.cz + 2 };
export const ZOMBIE_SHED = { x: F.cx - 4, z: F.cz + 30 };

export const ZOMBIE_GRAVE_ROWS: { x: number; z: number }[] = (() => {
  // the outer column stays WELL inside the fence ring — no stone touches iron
  const graves: { x: number; z: number }[] = [];
  for (const side of [-1, 1]) {
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 4; i++) {
        graves.push({
          x: F.cx + side * (8 + i * 4.0),
          z: F.cz - 13 + row * 6,
        });
      }
    }
  }
  return graves;
})();

// The iron fence ring (rendered in arcade.tsx with the SAME formula): 14
// segments at radius 26.5, gate gaps every 5th — and it is SOLID (see
// MODE_SOLIDS below): nobody phases through wrought iron.
export const ZOMBIE_FENCE_R = 26.5;
export const ZOMBIE_FENCE_SEGMENTS = 14;
export const zombieFenceGate = (i: number) => i % 5 === 2;

function makeZombiePlats(): Plat[] {
  const plats: Plat[] = [];
  // the crypt — one solid block (rendered as a stone mausoleum)
  plats.push({ x: ZOMBIE_CRYPT.x, z: ZOMBIE_CRYPT.z, y: 1.9, hw: 3.4, hd: 2.6 });
  // the obelisk plinth
  plats.push({ x: ZOMBIE_OBELISK.x, z: ZOMBIE_OBELISK.z, y: 1.9, hw: 0.9, hd: 0.9 });
  // ordered tombstones (thin blockers, aligned grid)
  for (const g of ZOMBIE_GRAVE_ROWS) {
    plats.push({ x: g.x, z: g.z, y: 1.6, hw: 0.55, hd: 0.2 });
  }
  // ruined wall segments framing the grave fields (fully INSIDE the fence ring)
  plats.push({ x: F.cx - 18, z: F.cz + 10, y: 1.9, hw: 4.2, hd: 0.5 });
  plats.push({ x: F.cx + 18, z: F.cz + 10, y: 1.9, hw: 4.2, hd: 0.5 });
  // low crates — cover you can jump onto (kept clear of the fence ring)
  plats.push({ x: F.cx - 13, z: F.cz + 19, y: 1.0, hw: 1.3, hd: 1.3 });
  plats.push({ x: F.cx + 13, z: F.cz + 19, y: 1.0, hw: 1.3, hd: 1.3 });
  plats.push({ x: F.cx - 8, z: F.cz - 22, y: 1.0, hw: 1.3, hd: 1.3 });
  plats.push({ x: F.cx + 8, z: F.cz - 22, y: 1.0, hw: 1.3, hd: 1.3 });
  // the derelict barn's footprint (rendered as a barn, collides as a block)
  plats.push({ x: F.cx - 34, z: F.cz - 30, y: 1.9, hw: 5.5, hd: 4.5 });
  // the ruined chapel — walk IN through the missing front wall
  plats.push({ x: F.cx + 26.5, z: F.cz + 22, y: 1.9, hw: 0.5, hd: 4.0 }); // west wall
  plats.push({ x: F.cx + 33.5, z: F.cz + 22, y: 1.9, hw: 0.5, hd: 4.0 }); // east wall
  plats.push({ x: F.cx + 30, z: F.cz + 18.5, y: 1.9, hw: 4.0, hd: 0.5 }); // back wall
  plats.push({ x: F.cx + 31.5, z: F.cz + 23.5, y: 1.0, hw: 1.0, hd: 1.0 }); // crate inside
  // the SHED — duck in through the south door: three walls + a workbench
  plats.push({ x: ZOMBIE_SHED.x - 2.6, z: ZOMBIE_SHED.z, y: 1.9, hw: 0.4, hd: 2.2 }); // west
  plats.push({ x: ZOMBIE_SHED.x + 2.6, z: ZOMBIE_SHED.z, y: 1.9, hw: 0.4, hd: 2.2 }); // east
  plats.push({ x: ZOMBIE_SHED.x, z: ZOMBIE_SHED.z - 2.0, y: 1.9, hw: 2.8, hd: 0.4 }); // back (north)
  plats.push({ x: ZOMBIE_SHED.x - 1.2, z: ZOMBIE_SHED.z - 0.9, y: 1.0, hw: 0.9, hd: 0.5 }); // workbench
  return plats;
}

export const ZOMBIE_PLATS: Plat[] = makeZombiePlats();

// Kill drops (no supply pads on the map): a slain zombie sometimes drops a
// power-up where it fell — walk over it before it fades.
export type DropKind = "max_ammo" | "insta_kill" | "health";
export const DROP_KINDS: DropKind[] = ["max_ammo", "insta_kill", "health"];
export const DROP_CHANCE = 0.02; // per normal kill — drops are an EVENT, not confetti
export const DROP_WAVE_CAP = 1; // at most one ground drop per wave (bosses bypass)
export const BOSS_DROP_CHANCE = 1; // bosses always pay out
export const DROP_DESPAWN_MS = 12_000;
export const INSTA_KILL_MS = 15_000;

// Where the chapel stands (for the renderer's dressing).
export const ZOMBIE_CHAPEL = { x: F.cx + 30, z: F.cz + 22 };

// ── Points + the Mystery Box ──────────────────────────────────────────────────
export const POINTS_PER_HIT = 10;
export const POINTS_PER_KILL = 60;
export const POINTS_PER_BOSS = 300;
export const MYSTERY_BOX = { x: F.cx + 30, z: F.cz + 26.5, cost: 500 };

// ── The horde's variety ───────────────────────────────────────────────────────
// Four non-boss archetypes. Tuning is DATA so the manager stays one code path:
// hp/speed multipliers, the bolt-collision column (radius/topY), where a
// headshot starts (headMin — null = no crit zone), bite damage, and bounty.
export type ZombieKind = "normal" | "runner" | "crawler" | "exploder";
export interface ZombieKindDef {
  hpMul: number;
  speedMul: number;
  radius: number;
  topY: number;
  headMin: number | null;
  bite: number;
  bounty: number;
}
export const ZOMBIE_KINDS: Record<ZombieKind, ZombieKindDef> = {
  normal: { hpMul: 1, speedMul: 1, radius: 1.0, topY: 2.1, headMin: 1.55, bite: 10, bounty: POINTS_PER_KILL },
  // fast, thin and fragile — punishes standing still
  runner: { hpMul: 0.6, speedMul: 1.5, radius: 0.9, topY: 2.0, headMin: 1.5, bite: 8, bounty: POINTS_PER_KILL + 15 },
  // low to the ground — body shots sail over it; you must aim DOWN
  crawler: { hpMul: 0.7, speedMul: 0.55, radius: 1.0, topY: 0.95, headMin: null, bite: 12, bounty: POINTS_PER_KILL + 10 },
  // detonates in your face — or from a safe distance, if you're sharp
  exploder: { hpMul: 1, speedMul: 0.9, radius: 1.05, topY: 2.1, headMin: 1.55, bite: 0, bounty: POINTS_PER_KILL + 25 },
};
export const EXPLODER_FUSE_DIST = 2.0; // this close, it blows itself
export const EXPLODER_BLAST_DIST = 4.2; // caught inside this → damage
export const EXPLODER_BLAST_DMG = 26;
export const HEADSHOT_MUL = 1.75;

/** Which kind spawns, by wave — variety arrives gradually, boss slots excluded. */
export function pickZombieKind(wave: number, roll: number): ZombieKind {
  if (wave >= 7 && roll < 0.12) return "exploder";
  if (wave >= 5 && roll < 0.28) return "crawler";
  if (wave >= 3 && roll < 0.5) return "runner";
  return "normal";
}

// ── Buying power beyond the box ───────────────────────────────────────────────
// Two WALL-BUYS (a known gun at a known price — the box stays the gamble) and
// one PERK machine (a one-time +50 max HP). All bought with E, all priced in
// the same kill-points economy.
export const ZOMBIE_WALLBUYS: { weapon: "shotgun" | "m4"; x: number; z: number; ry: number; cost: number }[] = [
  { weapon: "shotgun", x: ZOMBIE_SHED.x + 3.1, z: ZOMBIE_SHED.z, ry: Math.PI / 2, cost: 350 }, // the shed's east wall
  { weapon: "m4", x: ZOMBIE_CHAPEL.x - 3.9, z: ZOMBIE_CHAPEL.z, ry: -Math.PI / 2, cost: 500 }, // the chapel's west wall
];
export const ZOMBIE_PERK = { x: ZOMBIE_CRYPT.x + 5.2, z: ZOMBIE_CRYPT.z + 2.2, cost: 750, hpBonus: 50 };
// The second perk station — by the shed: QUICK HANDS cuts the reload nearly in
// half. Two perks means the points economy is now a CHOICE, not a checklist.
export const ZOMBIE_PERK2 = { x: ZOMBIE_SHED.x - 3.6, z: ZOMBIE_SHED.z + 1.6, cost: 600, reloadMul: 0.55 };

// ── Grenades: the pocket answer to a crowd ───────────────────────────────────
export const GRENADES_START = 2; // per run; MAX AMMO restocks them
export const GRENADE_BLAST_R = 3.6;
export const GRENADE_DMG = 34;
export const GRENADE_SELF_R = 2.5; // stand this close to your own blast and it bites
export const GRENADE_SELF_DMG = 15;
export const GRENADE_FUSE_MS = 1800;

// ── The armoury: six weapons, magazine-fed ────────────────────────────────────
// auto = hold the trigger; zoom = aim down the scope (right mouse, sniper).
export interface WeaponDef {
  id: "pistol" | "revolver" | "smg" | "m4" | "shotgun" | "sniper";
  name: string;
  fireMs: number; // between shots
  dmg: number; // per pellet
  pellets: number; // >1 sprays (shotgun)
  spread: number; // radians of jitter per pellet
  magSize: number; // rounds per magazine
  mags: number; // spare magazines when fully stocked
  auto: boolean;
  zoom?: boolean;
}

export const WEAPONS: Record<WeaponDef["id"], WeaponDef> = {
  pistol: { id: "pistol", name: "Pistol", fireMs: 230, dmg: 1, pellets: 1, spread: 0.012, magSize: 12, mags: 6, auto: false },
  revolver: { id: "revolver", name: "Revolver", fireMs: 520, dmg: 4, pellets: 1, spread: 0.008, magSize: 6, mags: 8, auto: false },
  smg: { id: "smg", name: "SMG", fireMs: 90, dmg: 1, pellets: 1, spread: 0.038, magSize: 30, mags: 5, auto: true },
  m4: { id: "m4", name: "M4", fireMs: 115, dmg: 2, pellets: 1, spread: 0.02, magSize: 30, mags: 5, auto: true },
  shotgun: { id: "shotgun", name: "Shotgun", fireMs: 650, dmg: 1, pellets: 6, spread: 0.09, magSize: 8, mags: 4, auto: false },
  sniper: { id: "sniper", name: "Sniper", fireMs: 950, dmg: 8, pellets: 1, spread: 0.004, magSize: 5, mags: 3, auto: false, zoom: true },
};
// What the box can roll (never the starter pistol).
export const BOX_POOL: WeaponDef["id"][] = ["revolver", "smg", "m4", "shotgun", "sniper"];
export const RELOAD_MS = 1600;
export const BOX_OFFER_MS = 15_000; // how long the rolled weapon hovers before it's gone

export const ZOMBIE_SPAWNS: { x: number; z: number }[] = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return { x: F.cx + Math.cos(a) * 54, z: F.cz + Math.sin(a) * 54 };
});
// Wave design: starts small, grows a couple per wave, trickle-spawned; every
// 5th wave brings a boss. Later waves RUN — but never faster than you.
export const WAVE_SIZE = (wave: number) => 3 + wave * 2;
export const WAVE_HAS_BOSS = (wave: number) => wave % 5 === 0;
export const MAX_ALIVE = 9;
// Zombie speed by wave: shamble → jog → run, capped safely under the player's
// walk-run range (player walks 9, runs 16).
export const zombieSpeed = (wave: number) => Math.min(8, 2.3 + wave * 0.28);

// ── Run boxes ────────────────────────────────────────────────────────────────
function standingOn(p: Plat, pad = 0.6): RunBox {
  return { x: p.x, z: p.z, hw: p.hw + pad, hd: p.hd + pad, minH: p.y - 0.7 };
}

export const CLIMB_START: RunBox = standingOn(CLIMB[0]);
export const CLIMB_GOAL: RunBox = standingOn(SUMMIT);
// The reset pad — Sky Climb has NO checkpoints and the clock never resets on a
// fall: falling costs you the whole climb. This ground pad by the start is the
// one way to wipe the run and go again — stand on it and the run (timer and
// all) resets, then cross the start box to re-arm.
export const CLIMB_RESET = { x: ARENAS.climb.spawn.x + 2, z: ARENAS.climb.spawn.z - 4, r: 2.2 };

export function inRunBox(b: RunBox, x: number, z: number, h: number): boolean {
  return h >= b.minH && Math.abs(x - b.x) <= b.hw && Math.abs(z - b.z) <= b.hd;
}

// Platforms per mode, for the player controller.
export const MODE_PLATS: Record<ArcadeModeId, Plat[]> = {
  climb: CLIMB,
  gauntlet: GAUNTLET_PLATS,
  arena: ZOMBIE_PLATS,
};

// ── Physics helpers (consumed by the Player controller every frame) ──────────

// Height of the ground under (x, z) for a body currently at height h: the
// highest platform top within reach (≤ h + STEP_UP) whose footprint contains
// the point — else the arena floor (0). The STEP_UP window is wider than a
// frame's fall distance, so fast falls can't tunnel through a slab.
export function platGroundAt(plats: Plat[], x: number, z: number, h: number): number {
  let g = 0;
  for (const p of plats) {
    if (p.y > h + STEP_UP) continue;
    if (Math.abs(x - p.x) <= p.hw + GRACE && Math.abs(z - p.z) <= p.hd + GRACE) {
      if (p.y > g) g = p.y;
    }
  }
  return g;
}

// Horizontal push-out against platform sides: a slab blocks you when its top
// is too high to step onto AND its underside is below your head — otherwise
// you pass under (or mantle onto) it freely. Axis of least penetration wins,
// same feel as the city's circle colliders.
export function resolvePlatXZ(plats: Plat[], nx: number, nz: number, h: number): [number, number] {
  for (let iter = 0; iter < 2; iter++) {
    for (const p of plats) {
      // `noJump` walls block whatever height you are at — there is no line over
      // them, only around them.
      if (!p.noJump && p.y <= h + STEP_UP) continue; // low enough to step/land on
      if (p.y - SLAB >= h + 1.75) continue; // slab entirely above the head
      const ex = p.hw + PLAYER_R;
      const ez = p.hd + PLAYER_R;
      const dx = nx - p.x;
      const dz = nz - p.z;
      if (Math.abs(dx) >= ex || Math.abs(dz) >= ez) continue;
      const px = ex - Math.abs(dx);
      const pz = ez - Math.abs(dz);
      if (px < pz) nx = p.x + (dx >= 0 ? 1 : -1) * ex;
      else nz = p.z + (dz >= 0 ? 1 : -1) * ez;
    }
  }
  return [nx, nz];
}

// Keep the player in the active clearing (the mountain ring is scenery).
export function clampToCircle(arena: ArenaDef, nx: number, nz: number): [number, number] {
  const dx = nx - arena.cx;
  const dz = nz - arena.cz;
  const rad = Math.hypot(dx, dz);
  if (rad > arena.r) return [arena.cx + (dx / rad) * arena.r, arena.cz + (dz / rad) * arena.r];
  return [nx, nz];
}

// Round solids per mode — cylinders the player can never pass through at any
// height below their top.
export interface ArcadeSolid {
  x: number;
  z: number;
  r: number;
  top: number; // blocks while the player's height is below this
}

// The valley-edge tree/rock/bush ring (same formula ArenaValley renders with —
// keep in sync) becomes solid trunks so nobody walks through a tree. `gapAt`
// skips a wedge (the gauntlet's spawn side stays clear of trunks).
function edgeRingSolids(arena: ArenaDef, gapAt?: { angle: number; span: number }): ArcadeSolid[] {
  const solids: ArcadeSolid[] = [];
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2 + 0.2;
    if (gapAt) {
      const d = Math.atan2(Math.sin(ang - gapAt.angle), Math.cos(ang - gapAt.angle));
      if (Math.abs(d) < gapAt.span) continue;
    }
    const rr = arena.r - 3 - (i % 3) * 1.5;
    solids.push({ x: arena.cx + Math.cos(ang) * rr, z: arena.cz + Math.sin(ang) * rr, r: 0.6, top: 3 });
  }
  return solids;
}
// The west wedge of the gauntlet edge ring stays empty — spawn + gates live there.
export const GAUNTLET_EDGE_GAP = { angle: Math.PI, span: 0.6 };

// The zombie fence ring becomes solid: three trunk-solids per segment along
// each straight fence piece (gates stay open).
function fenceSolids(): ArcadeSolid[] {
  const solids: ArcadeSolid[] = [];
  for (let i = 0; i < ZOMBIE_FENCE_SEGMENTS; i++) {
    if (zombieFenceGate(i)) continue;
    const a = (i / ZOMBIE_FENCE_SEGMENTS) * Math.PI * 2;
    const fx = F.cx + Math.cos(a) * ZOMBIE_FENCE_R;
    const fz = F.cz + Math.sin(a) * ZOMBIE_FENCE_R;
    // the segment runs perpendicular to the radius; sample 3 points along it
    const tx = -Math.sin(a);
    const tz = Math.cos(a);
    for (const d of [-3.1, 0, 3.1]) {
      solids.push({ x: fx + tx * d, z: fz + tz * d, r: 1.7, top: 1.6 });
    }
  }
  return solids;
}

export const MODE_SOLIDS: Record<ArcadeModeId, ArcadeSolid[]> = {
  climb: [
    // the spire shaft — full height
    { x: ARENAS.climb.cx, z: ARENAS.climb.cz, r: 2.4, top: 999 },
    // the rocky base mound — ground level only
    { x: ARENAS.climb.cx, z: ARENAS.climb.cz, r: 5.6, top: 0.9 },
    ...edgeRingSolids(ARENAS.climb),
  ],
  gauntlet: edgeRingSolids(ARENAS.gauntlet, GAUNTLET_EDGE_GAP),
  arena: [...edgeRingSolids(ARENAS.arena), ...fenceSolids()],
};

export function fmtMs(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m > 0 ? `${m}:${rest.toFixed(1).padStart(4, "0")}` : `${rest.toFixed(1)}s`;
}

// ── Minigame catalogue (drives the MINIGAMES overlay) ────────────────────────
export interface MinigameMeta {
  id: ArcadeModeId;
  icon: string;
  title: string;
  tagline: string;
  description: string;
  metric: "time" | "score";
}

export const MINIGAMES: MinigameMeta[] = [
  {
    id: "climb",
    icon: "🏔",
    title: "Sky Climb",
    tagline: "Only up.",
    description:
      "Race the clock up a hundred platforms of boulders, fallen logs, hay stacks, carts and crates — winding far out into the sky and back on their own paths. One missed jump can send you all the way down. Some gaps only a sprint-jump clears. Long, brutal, worth it.",
    metric: "time",
  },
  {
    id: "gauntlet",
    icon: "🏁",
    title: "The Gauntlet",
    tagline: "Out. Around. Home. If you can.",
    description:
      "A double-lane obstacle course with a hairpin at the far end: hurdles, four stepping-stone ponds, two wall slaloms, two ramparts to climb over, and seven spinning sweepers — including one guarding the turn itself. Ordered checkpoints, no shortcuts, and the clock never stops.",
    metric: "time",
  },
  {
    id: "arena",
    icon: "🧟",
    title: "Zombie Waves",
    tagline: "How long can you survive?",
    description:
      "The graveyard at the edge of the world. Waves grow, bosses arrive every fifth, and the dead RUN at higher rounds. Six weapons with real magazines — pistol to sniper (with a working scope) — kill drops, and the Mystery Box when your points run deep. It ends when you do.",
    metric: "score",
  },
];
