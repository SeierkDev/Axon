// Axon World Arcade — contracts:
// (1) every course is HUMANLY BEATABLE with the world's real jump physics
//     (Sky Climb hops incl. sprint gaps, Gauntlet stones/hurdles), walls that
//     must NOT be jumpable aren't, and every arena stays inside the presence
//     server's ±600 coordinate clamp;
// (2) the leaderboards are sane: time modes rank fastest-first, Zombie Waves
//     ranks highest-wave-first, weekly boards cut old runs, hostile names are
//     sanitised, implausible values are rejected.

import { describe, it, expect } from "vitest";
import {
  ARENAS,
  CLIMB,
  CLIMB_COUNT,
  SUMMIT,
  CLIMB_START,
  CLIMB_GOAL,
  GAUNTLET_STONES,
  GAUNTLET_HURDLES,
  GAUNTLET_WALLS,
  GAUNTLET_START,
  GAUNTLET_FINISH,
  GAUNTLET_CHECKPOINTS,
  GAUNTLET_PONDS,
  GAUNTLET_STAIRS,
  LANE_HALF,
  LANE_OFF,
  GAUNTLET_LANE_OOB,
  GAUNTLET_SIDEWALLS,
  GAUNTLET_SWEEPERS,
  GAUNTLET_TURNS,
  GAUNTLET_PLATS,
  ZOMBIE_FENCE_R,
  ZOMBIE_PLATS,
  ZOMBIE_SPAWNS,
  ZOMBIE_CRYPT,
  ZOMBIE_OBELISK,
  DROP_KINDS,
  DROP_CHANCE,
  BOSS_DROP_CHANCE,
  MODE_SOLIDS,
  WAVE_SIZE,
  WAVE_HAS_BOSS,
  WEAPONS,
  BOX_POOL,
  MYSTERY_BOX,
  MODE_PLATS,
  MINIGAMES,
  STEP_UP,
  inRunBox,
  platGroundAt,
  resolvePlatXZ,
  clampToCircle,
  fmtMs,
  makeClimbForDay,
  dailySeed,
  climbCourseSafe,
  GAUNTLET_STOMPERS,
  stomperHeadY,
  ZOMBIE_KINDS,
  pickZombieKind,
  ZOMBIE_WALLBUYS,
  ZOMBIE_PERK,
  type Plat,
} from "@/app/world/arcadeLayout";
import { submitArcadeRun, arcadeBoard, arcadeBoards, sanitizePlayer, ARCADE_MODES, startArcadeRun, minArenaDurationMs, lastWeekChampion } from "@/lib/arcade";
import { getDb } from "@/lib/db";

// Mirror of World3D's movement constants — if these drift, the reachability
// maths below no longer describes the real controller, so fail loudly.
const JUMP_V = 7.5;
const GRAVITY = 20;
const RUN_SPEED = 16;
const JUMP_APEX = (JUMP_V * JUMP_V) / (2 * GRAVITY); // 1.40m

function assertCourseClimbable(course: Plat[], label: string) {
  expect(course[0].y, `${label}[0] off the ground`).toBeLessThanOrEqual(JUMP_APEX - 0.2);
  for (let i = 1; i < course.length; i++) {
    const a = course[i - 1];
    const b = course[i];
    const rise = b.y - a.y;
    expect(rise, `${label}[${i}] rise`).toBeLessThanOrEqual(JUMP_APEX - 0.3);
    const tLand = (JUMP_V + Math.sqrt(JUMP_V * JUMP_V - 2 * GRAVITY * Math.max(0, rise))) / GRAVITY;
    const reach = RUN_SPEED * tLand;
    const centerGap = Math.hypot(b.x - a.x, b.z - a.z);
    const edgeGap = Math.max(0, centerGap - Math.min(a.hw, a.hd) - Math.min(b.hw, b.hd));
    expect(edgeGap, `${label}[${i}] gap`).toBeLessThan(reach - 0.5);
  }
}

describe("Sky Climb", () => {
  it("is long, varied, and every hop is makeable", () => {
    expect(CLIMB).toHaveLength(CLIMB_COUNT);
    expect(CLIMB_COUNT).toBeGreaterThanOrEqual(80); // a HARD run, not a hop
    expect(SUMMIT.y).toBeGreaterThan(70); // ~80m of tower
    expect(SUMMIT).toEqual(CLIMB[CLIMB.length - 1]);
    assertCourseClimbable(CLIMB, "climb");
    // genuinely varied platform props (the whole point)
    expect(new Set(CLIMB.map((p) => p.kind)).size).toBeGreaterThanOrEqual(6);
    // platforms are generous to land on
    for (const p of CLIMB) expect(Math.min(p.hw, p.hd)).toBeGreaterThanOrEqual(1.25);
    // some gaps demand a sprint-jump: wider than any walk-jump can cover
    const WALK_REACH_FLAT = 9 * ((JUMP_V + Math.sqrt(JUMP_V * JUMP_V)) / GRAVITY); // 6.75m
    const sprintGaps = CLIMB.filter((p, i) => {
      if (i === 0) return false;
      const a = CLIMB[i - 1];
      const gap = Math.hypot(p.x - a.x, p.z - a.z) - Math.min(a.hw, a.hd) - Math.min(p.hw, p.hd);
      return gap > WALK_REACH_FLAT - 1.5;
    });
    expect(sprintGaps.length).toBeGreaterThanOrEqual(6);
  });

  it("start/goal boxes sit on their platforms", () => {
    expect(inRunBox(CLIMB_START, CLIMB[0].x, CLIMB[0].z, CLIMB[0].y)).toBe(true);
    expect(inRunBox(CLIMB_START, CLIMB[0].x, CLIMB[0].z, 0)).toBe(false); // under it ≠ on it
    expect(inRunBox(CLIMB_GOAL, SUMMIT.x, SUMMIT.z, SUMMIT.y)).toBe(true);
  });

  it("every DAILY course for the next year is climbable (the seed rotates)", () => {
    // the generator validates + deterministically retries per day; this proves a
    // full year of daily seeds never ships an unclimbable route
    for (let d = 0; d < 366; d += 1) {
      const course = makeClimbForDay(dailySeed(d));
      expect(climbCourseSafe(course), `day +${d}`).toBe(true);
      assertCourseClimbable(course, `day+${d}`);
    }
  });

  it("crumble ledges are never rest pads and never the opening stretch", () => {
    const crumbles = CLIMB.filter((p) => p.crumble);
    expect(crumbles.length).toBeGreaterThanOrEqual(6); // camping is not a strategy
    for (const p of crumbles) expect(p.rest).toBe(false);
    for (let i = 0; i <= 12; i++) expect(CLIMB[i].crumble ?? false).toBe(false);
  });
});

describe("The Gauntlet (S-course)", () => {
  it("is a THREE-leg course — the checkpoint path measures the full S", () => {
    // path length through the ordered checkpoints, plus the run to the finish
    const pts = [...GAUNTLET_CHECKPOINTS, { x: GAUNTLET_FINISH.x, z: GAUNTLET_FINISH.z }];
    let path = 0;
    for (let i = 1; i < pts.length; i++) path += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    expect(path).toBeGreaterThanOrEqual(430); // three ~170m legs + two hairpins
    for (const h of GAUNTLET_HURDLES) expect(h.y).toBeLessThanOrEqual(JUMP_APEX - 0.2);
    expect(GAUNTLET_WALLS.length).toBeGreaterThanOrEqual(18); // slaloms on ALL THREE legs
    for (const w of GAUNTLET_WALLS) {
      expect(w.y).toBeGreaterThan(JUMP_APEX + 0.4); // can't hop them…
      expect(w.y - 0.6).toBeLessThan(1.75); // …and can't walk under them either
    }
  });

  it("all six ponds are crossed by makeable stepping stones over the water", () => {
    expect(GAUNTLET_PONDS).toHaveLength(6);
    for (const pond of GAUNTLET_PONDS) {
      const stones = GAUNTLET_STONES.filter(
        (s) => s.x > pond.x1 && s.x < pond.x2 && s.z > pond.z1 - 3 && s.z < pond.z2 + 3,
      );
      expect(stones.length).toBeGreaterThanOrEqual(4);
      assertCourseClimbable(stones, `stones@${pond.x1.toFixed(0)}`);
    }
    // every stone belongs to exactly one pond (legs never share stones)
    for (const s of GAUNTLET_STONES) {
      const homes = GAUNTLET_PONDS.filter(
        (p) => s.x > p.x1 && s.x < p.x2 && s.z > p.z1 - 3 && s.z < p.z2 + 3,
      );
      expect(homes).toHaveLength(1);
    }
  });

  it("checkpoints trace the S in order: east, hairpin, west, hairpin, east to the line", () => {
    const cps = GAUNTLET_CHECKPOINTS;
    expect(cps.length).toBeGreaterThanOrEqual(14);
    expect(cps[0]).toEqual({ x: GAUNTLET_START.x, z: GAUNTLET_START.z });
    // start west on the south leg, finish EAST on the north leg — opposite corners
    expect(GAUNTLET_FINISH.x - GAUNTLET_START.x).toBeGreaterThanOrEqual(150);
    expect(Math.abs(GAUNTLET_FINISH.z - GAUNTLET_START.z)).toBeGreaterThanOrEqual(28);
    // per-leg direction: south leg runs east, middle leg runs west, north leg runs east
    const laneOf = (c: { z: number }) => Math.round((c.z - GAUNTLET_TURNS[0].z - 8) / 16); // -1, 0, +1
    for (let i = 1; i < cps.length; i++) {
      const a = cps[i - 1], b = cps[i];
      if (laneOf(a) === laneOf(b)) {
        if (laneOf(a) === 0) expect(b.x).toBeLessThan(a.x); // middle leg heads west
        else expect(b.x).toBeGreaterThan(a.x); // outer legs head east
      }
    }
    // consecutive checkpoints stay close enough that a reset never feels brutal
    for (let i = 1; i < cps.length; i++) {
      expect(Math.hypot(cps[i].x - cps[i - 1].x, cps[i].z - cps[i - 1].z)).toBeLessThanOrEqual(46);
    }
    // each hairpin checkpoint sits INSIDE its turn arm's sweep — the turn can't be waited out
    for (const turn of GAUNTLET_TURNS) {
      const arm = GAUNTLET_SWEEPERS.find((s) => s.cx === turn.x && s.cz === turn.z);
      expect(arm, "every hairpin has its arm").toBeTruthy();
      const cp = GAUNTLET_CHECKPOINTS.find((c) => Math.hypot(c.x - turn.x, c.z - turn.z) < arm!.r);
      expect(cp, "hairpin checkpoint inside the arm's sweep").toBeTruthy();
    }
    expect(GAUNTLET_SWEEPERS.length).toBeGreaterThanOrEqual(8);
    // both gates trigger at ground level
    expect(GAUNTLET_START.minH).toBe(0);
    expect(GAUNTLET_FINISH.minH).toBe(0);
  });

  it("NOTHING intersects: sweeper arms sweep clear of every platform, wall and stair", () => {
    // rectangle-circle overlap: closest point on the plat footprint vs swept disc
    for (const sw of GAUNTLET_SWEEPERS) {
      for (const p of GAUNTLET_PLATS) {
        const px = Math.max(p.x - p.hw, Math.min(sw.cx, p.x + p.hw));
        const pz = Math.max(p.z - p.hd, Math.min(sw.cz, p.z + p.hd));
        const d = Math.hypot(sw.cx - px, sw.cz - pz);
        expect(d, `sweeper@(${sw.cx.toFixed(0)},${sw.cz.toFixed(0)}) vs plat@(${p.x.toFixed(0)},${p.z.toFixed(0)})`).toBeGreaterThan(sw.r + 0.15);
      }
    }
  });
});

describe("Zombie Waves layout + wave design", () => {
  it("graves, ruins, pickups and spawns all sit inside the arena", () => {
    const f = ARENAS.arena;
    for (const p of ZOMBIE_PLATS) {
      expect(Math.hypot(p.x - f.cx, p.z - f.cz)).toBeLessThan(f.r - 1);
    }
    for (const p of ZOMBIE_SPAWNS) {
      expect(Math.hypot(p.x - f.cx, p.z - f.cz)).toBeLessThanOrEqual(f.r - 4);
    }
    // the crypt + obelisk stand at the heart of the map (and collide)
    expect(ZOMBIE_PLATS.some((c) => c.x === ZOMBIE_CRYPT.x && c.z === ZOMBIE_CRYPT.z)).toBe(true);
    expect(ZOMBIE_PLATS.some((c) => c.x === ZOMBIE_OBELISK.x && c.z === ZOMBIE_OBELISK.z)).toBe(true);
    // tall cover blocks (unjumpable), low crates are vantage points
    expect(ZOMBIE_PLATS.some((c) => c.y > JUMP_APEX)).toBe(true);
    expect(ZOMBIE_PLATS.some((c) => c.y <= 1.0)).toBe(true);
  });

  it("kill drops are sane: three kinds, RARE on grunts, guaranteed on bosses", () => {
    expect(DROP_KINDS).toEqual(["max_ammo", "insta_kill", "health"]);
    expect(DROP_CHANCE).toBeGreaterThan(0);
    expect(DROP_CHANCE).toBeLessThanOrEqual(0.03); // an event, not a vending machine
    expect(BOSS_DROP_CHANCE).toBe(1);
  });

  it("no structure straddles the iron fence ring — everything is clearly in or out", () => {
    const f = ARENAS.arena;
    for (const p of ZOMBIE_PLATS) {
      // the plat footprint's nearest + farthest distance from the arena centre
      const corners = [
        [p.x - p.hw, p.z - p.hd], [p.x + p.hw, p.z - p.hd],
        [p.x - p.hw, p.z + p.hd], [p.x + p.hw, p.z + p.hd],
      ].map(([x, z]) => Math.hypot(x - f.cx, z - f.cz));
      const nearest = Math.min(...corners);
      const farthest = Math.max(...corners);
      const inOrOut = farthest < ZOMBIE_FENCE_R - 0.8 || nearest > ZOMBIE_FENCE_R + 0.8;
      expect(inOrOut, `plat@(${p.x.toFixed(0)},${p.z.toFixed(0)}) straddles the fence`).toBe(true);
    }
  });

  it("the climb spire is solid: a shaft the full height plus a ground-level base", () => {
    const solids = MODE_SOLIDS.climb;
    expect(solids.length).toBeGreaterThanOrEqual(2);
    const shaft = solids.find((so) => so.top > 100)!;
    expect(shaft).toBeDefined();
    expect(shaft.r).toBeGreaterThan(1.5);
    // every climb platform's inner edge clears the shaft (standing room)
    for (const c of CLIMB) {
      const d = Math.hypot(c.x - shaft.x, c.z - shaft.z) - Math.min(c.hw, c.hd);
      expect(d).toBeGreaterThan(shaft.r + 0.7);
    }
  });

  it("waves grow steadily and every 5th brings a boss", () => {
    expect(WAVE_SIZE(1)).toBeLessThanOrEqual(6); // starts easy
    for (let w = 1; w < 20; w++) {
      const growth = WAVE_SIZE(w + 1) - WAVE_SIZE(w);
      expect(growth).toBeGreaterThanOrEqual(1);
      expect(growth).toBeLessThanOrEqual(2); // one or two more each wave, never a flood
    }
    expect(WAVE_HAS_BOSS(5)).toBe(true);
    expect(WAVE_HAS_BOSS(10)).toBe(true);
    expect(WAVE_HAS_BOSS(3)).toBe(false);
  });

  it("the armoury is sane: six magazine-fed weapons, the box never rolls the starter pistol", () => {
    expect(Object.keys(WEAPONS)).toHaveLength(6);
    for (const w of Object.values(WEAPONS)) {
      expect(w.fireMs).toBeGreaterThan(0);
      expect(w.dmg).toBeGreaterThan(0);
      expect(w.pellets).toBeGreaterThanOrEqual(1);
      expect(w.magSize).toBeGreaterThan(0);
      expect(w.mags).toBeGreaterThan(0);
    }
    // automatics are the hold-to-fire pair; the sniper is the only scope
    expect(WEAPONS.smg.auto).toBe(true);
    expect(WEAPONS.m4.auto).toBe(true);
    expect(WEAPONS.sniper.zoom).toBe(true);
    expect(WEAPONS.shotgun.auto).toBe(false);
    // the sniper carries the least ammo, the shotgun less than the automatics
    expect(WEAPONS.sniper.magSize * (WEAPONS.sniper.mags + 1)).toBeLessThan(WEAPONS.shotgun.magSize * (WEAPONS.shotgun.mags + 1));
    expect(WEAPONS.shotgun.magSize * (WEAPONS.shotgun.mags + 1)).toBeLessThan(WEAPONS.smg.magSize * (WEAPONS.smg.mags + 1));
    expect(BOX_POOL).not.toContain("pistol");
    expect(BOX_POOL).toHaveLength(5);
    for (const id of BOX_POOL) expect(WEAPONS[id]).toBeDefined();
    expect(MYSTERY_BOX.cost).toBeGreaterThan(0);
    // the box stands inside the arena
    const f = ARENAS.arena;
    expect(Math.hypot(MYSTERY_BOX.x - f.cx, MYSTERY_BOX.z - f.cz)).toBeLessThan(f.r - 2);
  });
});

describe("arenas + physics helpers", () => {
  it("every arena and its platforms stay inside the ±600 presence clamp", () => {
    for (const [id, a] of Object.entries(ARENAS)) {
      expect(Math.abs(a.cx) + a.r, `${id} cx`).toBeLessThanOrEqual(600);
      expect(Math.abs(a.cz) + a.r, `${id} cz`).toBeLessThanOrEqual(600);
      for (const p of MODE_PLATS[id as keyof typeof MODE_PLATS]) {
        expect(Math.hypot(p.x - a.cx, p.z - a.cz), `${id} plat`).toBeLessThan(a.r - 0.5);
      }
      expect(Math.hypot(a.spawn.x - a.cx, a.spawn.z - a.cz), `${id} spawn`).toBeLessThan(a.r);
    }
  });

  it("ground height + side collision + circle clamp behave", () => {
    const p = CLIMB[5];
    expect(platGroundAt(CLIMB, p.x, p.z, p.y)).toBe(p.y);
    expect(platGroundAt(CLIMB, p.x, p.z, p.y + STEP_UP - 0.01)).toBe(p.y);
    expect(platGroundAt(CLIMB, p.x, p.z, 0)).toBeLessThan(p.y);
    // a chest-height slab blocks sideways movement
    const [nx, nz] = resolvePlatXZ(CLIMB, p.x, p.z, p.y - 1.0);
    expect(Math.abs(nx - p.x) > p.hw || Math.abs(nz - p.z) > p.hd).toBe(true);
    // standing on it is not blocked; far above everything nothing blocks
    const [sx, sz] = resolvePlatXZ(CLIMB, p.x, p.z, p.y);
    expect([sx, sz]).toEqual([p.x, p.z]);
    const [ux, uz] = resolvePlatXZ(CLIMB, p.x, p.z, SUMMIT.y + 5);
    expect([ux, uz]).toEqual([p.x, p.z]);
    // clamp
    const a = ARENAS.climb;
    const [cx, cz] = clampToCircle(a, a.cx + a.r * 3, a.cz);
    expect(Math.hypot(cx - a.cx, cz - a.cz)).toBeCloseTo(a.r, 5);
  });

  it("formats times", () => {
    expect(fmtMs(9_400)).toBe("9.4s");
    expect(fmtMs(83_250)).toBe("1:23.3");
  });

  it("the catalogue and the server modes agree", () => {
    for (const m of MINIGAMES) {
      expect(ARCADE_MODES[m.id], m.id).toBeDefined();
      expect(ARCADE_MODES[m.id].metric).toBe(m.metric);
    }
  });
});

describe("arcade leaderboards", () => {
  it("time modes rank fastest-first, best per player", () => {
    const a = submitArcadeRun({ mode: "climb", player: "alice", ms: 61_000 });
    expect(a.rank).toBe(1);
    const b = submitArcadeRun({ mode: "climb", player: "bob", ms: 45_000 });
    expect(b.rank).toBe(1);
    const a2 = submitArcadeRun({ mode: "climb", player: "alice", ms: 50_000 });
    expect(a2.rank).toBe(2);
    const board = arcadeBoard("climb");
    expect(board.top[0]).toMatchObject({ player: "bob", ms: 45_000 });
    expect(board.top[1]).toMatchObject({ player: "alice", ms: 50_000 });
  });

  it("Zombie Waves ranks highest-wave-first", () => {
    submitArcadeRun({ mode: "arena", player: "few", ms: 4 });
    const many = submitArcadeRun({ mode: "arena", player: "many", ms: 17 });
    expect(many.rank).toBe(1);
    const few2 = submitArcadeRun({ mode: "arena", player: "few", ms: 9 });
    expect(few2.rank).toBe(2); // improved, still behind
    const board = arcadeBoard("arena");
    expect(board.top[0]).toMatchObject({ player: "many", ms: 17 });
    expect(board.top[1]).toMatchObject({ player: "few", ms: 9 }); // best (max), not latest
  });

  it("weekly board excludes runs older than 7 days; all-time keeps them", () => {
    submitArcadeRun({ mode: "gauntlet", player: "fresh", ms: 30_000 });
    getDb()
      .prepare(`INSERT INTO arcade_runs (mode, player, ms, created_at) VALUES (?, ?, ?, ?)`)
      .run("gauntlet", "ancient", 26_000, new Date(Date.now() - 30 * 24 * 3_600_000).toISOString());
    const { week, allTime } = arcadeBoards("gauntlet");
    expect(allTime.top[0]).toMatchObject({ player: "ancient", ms: 26_000 });
    expect(week.top.map((e) => e.player)).not.toContain("ancient");
    expect(week.top[0]).toMatchObject({ player: "fresh", ms: 30_000 });
  });

  it("rejects implausible values and unknown modes", () => {
    expect(() => submitArcadeRun({ mode: "climb", player: "x", ms: 3_000 })).toThrow(/implausible/);
    expect(() => submitArcadeRun({ mode: "climb", player: "x", ms: 4_000_000 })).toThrow(/implausible/);
    expect(() => submitArcadeRun({ mode: "arena", player: "x", ms: 999 })).toThrow(/implausible/);
    expect(() => submitArcadeRun({ mode: "arena", player: "x", ms: 0 })).toThrow(/implausible/);
    expect(() => submitArcadeRun({ mode: "warp-hack", player: "x", ms: 60_000 })).toThrow(/unknown/);
  });

  it("sanitises hostile player names", () => {
    expect(sanitizePlayer("  spaced   out  ")).toBe("spaced out");
    expect(sanitizePlayer("evil\u0000\u0007name")).toBe("evilname");
    expect(sanitizePlayer("")).toBe("traveler");
    expect(sanitizePlayer(12345)).toBe("traveler");
    expect(sanitizePlayer("x".repeat(60)).length).toBeLessThanOrEqual(24);
  });
});

describe("Run tokens — the anti-cheat spine", () => {
  it("a timed run must match the server clock; a token can't be spent twice", () => {
    const { runId } = startArcadeRun("climb");
    // the server JUST started this run — claiming 30s elapsed is a lie
    expect(() => submitArcadeRun({ mode: "climb", player: "cheat", ms: 30_000, runId })).toThrow(/server clock/);
    // and even the failed attempt consumed the token — no replays
    expect(() => submitArcadeRun({ mode: "climb", player: "cheat", ms: 30_000, runId })).toThrow(/already used/);
  });

  it("rejects unknown, missing and cross-mode tokens", () => {
    expect(() => submitArcadeRun({ mode: "climb", player: "x", ms: 30_000, runId: "not-a-real-token" })).toThrow(/unknown run token/);
    expect(() => submitArcadeRun({ mode: "climb", player: "x", ms: 30_000, runId: 7 })).toThrow(/missing run token/);
    const { runId } = startArcadeRun("gauntlet");
    expect(() => submitArcadeRun({ mode: "climb", player: "x", ms: 30_000, runId })).toThrow(/different mode/);
  });

  it("a wave count cannot arrive faster than the waves can spawn", () => {
    const { runId } = startArcadeRun("arena");
    // wave 30 needs minutes of real time; this token is seconds old
    expect(() => submitArcadeRun({ mode: "arena", player: "x", ms: 30, runId })).toThrow(/faster than the waves/);
    // wave 1 needs no elapsed time at all — a fresh token passes
    const { runId: r2 } = startArcadeRun("arena");
    expect(() => submitArcadeRun({ mode: "arena", player: "waver", ms: 1, runId: r2 })).not.toThrow();
  });

  it("minArenaDurationMs grows with the wave and starts at zero", () => {
    expect(minArenaDurationMs(1)).toBe(0);
    expect(minArenaDurationMs(5)).toBeGreaterThan(minArenaDurationMs(3));
    expect(minArenaDurationMs(20)).toBeGreaterThan(60_000); // wave 20 = minutes, not seconds
  });

  it("last week's champion is captured from the archived window", () => {
    const db = getDb();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    db.prepare(`INSERT INTO arcade_runs (mode, player, ms, created_at) VALUES ('gauntlet', 'oldking', 61000, ?)`).run(tenDaysAgo);
    const champ = lastWeekChampion("gauntlet");
    expect(champ?.player).toBe("oldking");
    // …and a run from THIS week doesn't steal last week's crown
    db.prepare(`INSERT INTO arcade_runs (mode, player, ms, created_at) VALUES ('gauntlet', 'newkid', 31000, ?)`).run(new Date().toISOString());
    expect(lastWeekChampion("gauntlet")?.player).toBe("oldking");
  });
});

describe("Gauntlet stompers", () => {
  it("three pistons, one per leg, clear of every other obstacle", () => {
    expect(GAUNTLET_STOMPERS.length).toBe(3);
    expect(new Set(GAUNTLET_STOMPERS.map((s) => s.z)).size).toBe(3);
    for (const s of GAUNTLET_STOMPERS) {
      for (const pond of GAUNTLET_PONDS) {
        const inPond = s.z > pond.z1 - 2 && s.z < pond.z2 + 2 && s.x > pond.x1 - 3 && s.x < pond.x2 + 3;
        expect(inPond, "stomper in a pond").toBe(false);
      }
      for (const sw of GAUNTLET_SWEEPERS) {
        expect(Math.hypot(sw.cx - s.x, sw.cz - s.z)).toBeGreaterThan(sw.r + 3.5);
      }
    }
  });

  it("the head cycle is periodic, bounded, and actually slams", () => {
    const s = GAUNTLET_STOMPERS[0];
    let min = Infinity, max = -Infinity;
    for (let t = 0; t < s.period * 2; t += 0.02) {
      const y = stomperHeadY(s, t);
      min = Math.min(min, y);
      max = Math.max(max, y);
      expect(y).toBeGreaterThan(0.3);
      expect(y).toBeLessThanOrEqual(3.2);
    }
    expect(min).toBeLessThan(0.5); // it comes down for real
    expect(max).toBe(3.2); // and hangs clear overhead
    expect(stomperHeadY(s, 1)).toBeCloseTo(stomperHeadY(s, 1 + s.period), 6); // periodic
  });
});

describe("Zombie kinds + buys", () => {
  it("kind tuning is sane: crawlers are low, runners are fast+fragile", () => {
    expect(ZOMBIE_KINDS.crawler.topY).toBeLessThan(1.2); // body shots sail over
    expect(ZOMBIE_KINDS.crawler.headMin).toBeNull();
    expect(ZOMBIE_KINDS.runner.speedMul).toBeGreaterThan(1.2);
    expect(ZOMBIE_KINDS.runner.hpMul).toBeLessThan(1);
    for (const k of Object.values(ZOMBIE_KINDS)) {
      expect(k.bounty).toBeGreaterThanOrEqual(60);
      expect(k.radius).toBeGreaterThan(0.5);
    }
  });

  it("variety arrives gradually by wave", () => {
    expect(pickZombieKind(1, 0.01)).toBe("normal"); // wave 1-2: normals only
    expect(pickZombieKind(3, 0.4)).toBe("runner");
    expect(pickZombieKind(5, 0.2)).toBe("crawler");
    expect(pickZombieKind(7, 0.05)).toBe("exploder");
    expect(pickZombieKind(20, 0.99)).toBe("normal"); // normals never vanish
  });

  it("wall-buys + perk sit inside the playable arena and cost real points", () => {
    const F = ARENAS.arena;
    const spots = [...ZOMBIE_WALLBUYS.map((b) => ({ x: b.x, z: b.z, cost: b.cost })), { x: ZOMBIE_PERK.x, z: ZOMBIE_PERK.z, cost: ZOMBIE_PERK.cost }];
    for (const w of spots) {
      // the play space is the arena circle (the iron fence is a decorated
      // sub-ring with gates — the shed deliberately sits beyond it)
      expect(Math.hypot(w.x - F.cx, w.z - F.cz)).toBeLessThan(F.r - 2);
      expect(w.cost).toBeGreaterThanOrEqual(300);
    }
  });
});

describe("The Gauntlet — no way round the course", () => {
  const G = ARENAS.gauntlet;
  const PLAYER_R = 0.7;

  /** Is a player standing at (x, z) at height h overlapping any solid? */
  function blocked(x: number, z: number, h: number): boolean {
    for (const p of GAUNTLET_PLATS) {
      if (!p.noJump && p.y <= h + STEP_UP) continue;
      if (p.y - 0.6 >= h + 1.75) continue;
      if (Math.abs(x - p.x) < p.hw + PLAYER_R && Math.abs(z - p.z) < p.hd + PLAYER_R) return true;
    }
    return false;
  }
  const inPond = (x: number, z: number) =>
    GAUNTLET_PONDS.some((q) => x > q.x1 && x < q.x2 && z > q.z1 && z < q.z2);

  /** The widest run of z along which a whole leg is walkable untouched. */
  function bypassWidth(laneZ: number, x1: number, x2: number): number {
    let best = 0, run = 0;
    for (let z = laneZ - 9; z <= laneZ + 9; z += 0.1) {
      let clear = true;
      for (let x = x1; x <= x2; x += 0.5) {
        if (blocked(x, z, 0) || inPond(x, z)) { clear = false; break; }
      }
      if (clear) { run += 0.1; best = Math.max(best, run); } else run = 0;
    }
    return best;
  }

  it("has no lane you can run the length of without meeting an obstacle", () => {
    // Obstacles are sized to their corridor, not to the lane. Size them to the
    // lane and a strip of open grass runs beside every hurdle.
    for (const laneZ of [G.cz - LANE_OFF, G.cz, G.cz + LANE_OFF]) {
      expect(bypassWidth(laneZ, G.cx - 60, G.cx + 55)).toBeLessThan(PLAYER_R * 2);
    }
  });

  it("has no boundary hedge a standing jump can clear", () => {
    // A flat-ground jump peaks at 1.41m; a 1.9m wall stops colliding at 1.35m.
    // Six centimetres was the whole exploit — over the hedge and onto the green.
    const apex = (JUMP_V * JUMP_V) / (2 * GRAVITY);
    expect(GAUNTLET_SIDEWALLS.filter((p) => !p.noJump && p.y <= apex + STEP_UP)).toHaveLength(0);
  });

  it("treats everything past the outer hedge as out of bounds", () => {
    // Leave a margin beyond the hedge and that margin is a free lane: outside
    // the course, still in bounds, no obstacles for 170 metres.
    const outerFace = LANE_OFF + LANE_HALF + 1.7 + 0.5;
    expect(GAUNTLET_LANE_OOB.halfZ).toBeLessThanOrEqual(outerFace);
  });

  it("leaves a runnable gap through every slalom tooth", () => {
    const teeth = GAUNTLET_WALLS.filter((w) => w.y === 1.9); // slalom, not rampart
    expect(teeth.length).toBeGreaterThan(0);
    for (const w of teeth) {
      const laneZ = [G.cz - LANE_OFF, G.cz, G.cz + LANE_OFF]
        .reduce((a, b) => (Math.abs(b - w.z) < Math.abs(a - w.z) ? b : a));
      const lo = w.z - w.hd - PLAYER_R, hi = w.z + w.hd + PLAYER_R;
      const gap = Math.max((laneZ + 7.4) - hi, lo - (laneZ - 7.4));
      expect(gap).toBeGreaterThanOrEqual(PLAYER_R * 2);
    }
  });

  it("keeps every rampart climbable by its stairs", () => {
    const apex = (JUMP_V * JUMP_V) / (2 * GRAVITY);
    const ramparts = GAUNTLET_WALLS.filter((w) => w.y === 2.2);
    expect(ramparts).toHaveLength(3);
    for (const r of ramparts) {
      // Unjumpable by design, so the stairs are the only way over — the top
      // step has to stay inside the (now wider) rampart footprint.
      expect(r.y - STEP_UP).toBeGreaterThan(apex);
      const top = GAUNTLET_STAIRS.filter((s) => s.y === 2.2 && Math.abs(s.x - r.x) < 2);
      expect(top.length).toBeGreaterThan(0);
      for (const s of top) expect(Math.abs(s.z - r.z)).toBeLessThan(r.hd);
    }
  });
});
