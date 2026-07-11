"use client";

// Axon World Arcade — the renderable pieces of the minigame layer.
//
// Minigames are opened from the 🎮 MINIGAMES tab (top-right of the world), not
// walked to: the overlay lists every mode, gates entry (Phantom sign-in +
// holding $AXON — see World3D), and PLAY warps the player to that mode's own
// arena clearing far outside town. Every clearing is dressed like the city —
// same grass, the same BoundaryScenery mountain country — so no edge ever
// reads as a void. All geometry comes from arcadeLayout.ts: what you see is
// exactly what you collide with.

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Instances, Instance } from "@react-three/drei";
import * as THREE from "three";
import { Tree, Rock, Bush, Cloud, Flowers, GrassTuft, Barrel, Cart, HayBale, LampPost, Barn, LilyPad, MarketStall, shade } from "./decor";
import { BoundaryScenery } from "./OpenWorld";
import { worldSfx, worldWind, zombieMusic } from "./audio";
import { arcadeFx, arcadeShake } from "./arcadeFx";
import { EntityManager, Vehicle, SeekBehavior, SeparationBehavior, WanderBehavior, Vector3 as YVector3 } from "yuka";
import {
  ARENAS,
  type ArcadeModeId,
  type ArenaDef,
  type ZombieKind,
  CLIMB,
  setClimbPlatY,
  CLIMB_RESET,
  SUMMIT,
  GAUNTLET_STOMPERS,
  stomperHeadY,
  ZOMBIE_KINDS,
  pickZombieKind,
  EXPLODER_FUSE_DIST,
  EXPLODER_BLAST_DIST,
  EXPLODER_BLAST_DMG,
  HEADSHOT_MUL,
  ZOMBIE_WALLBUYS,
  ZOMBIE_PERK,
  ZOMBIE_PERK2,
  GRENADES_START,
  GRENADE_BLAST_R,
  GRENADE_DMG,
  GRENADE_SELF_R,
  GRENADE_SELF_DMG,
  GRENADE_FUSE_MS,
  CLIMB_SPRINGS,
  GAUNTLET_SPEED_PADS,
  dailySeed,
  GAUNTLET_STONES,
  GAUNTLET_HURDLES,
  GAUNTLET_WALLS,
  GAUNTLET_START,
  GAUNTLET_FINISH,
  GAUNTLET_CHECKPOINTS,
  GAUNTLET_PONDS,
  GAUNTLET_SWEEPERS,
  GAUNTLET_TURNS,
  GAUNTLET_SIDEWALLS,
  GAUNTLET_STAIRS,
  GAUNTLET_LANE_OOB,
  LANE_HALF,
  LANE_OFF,
  ZOMBIE_PLATS,
  ZOMBIE_SPAWNS,
  ZOMBIE_CRYPT,
  ZOMBIE_OBELISK,
  DROP_KINDS,
  DROP_CHANCE,
  BOSS_DROP_CHANCE,
  DROP_DESPAWN_MS,
  INSTA_KILL_MS,
  type DropKind,
  ZOMBIE_CHAPEL,
  WAVE_SIZE,
  WAVE_HAS_BOSS,
  MAX_ALIVE,
  RELOAD_MS,
  DROP_WAVE_CAP,
  BOX_OFFER_MS,
  zombieSpeed,
  ZOMBIE_SHED,
  WEAPONS,
  BOX_POOL,
  MYSTERY_BOX,
  POINTS_PER_HIT,
  POINTS_PER_BOSS,
  type WeaponDef,
  resolvePlatXZ,
  inRunBox,
  type RunBox,
  MINIGAMES,
} from "./arcadeLayout";

type Vec3 = [number, number, number];

// ── Tiny canvas-texture label (billboarded) ───────────────────────────────────
function Label({ text, position, scale = 3.4, color = "#14b8a6" }: { text: string; position: Vec3; scale?: number; color?: string }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(15, 20, 24, 0.72)";
    ctx.beginPath();
    ctx.roundRect(6, 18, 500, 92, 26);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f0fdfa";
    // auto-fit: start at 52px and shrink until the text fits inside the panel
    let fontPx = 52;
    do {
      ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
      if (ctx.measureText(text).width <= 452) break;
      fontPx -= 3;
    } while (fontPx > 22);
    ctx.fillText(text, 256, 66);
    const t = new THREE.CanvasTexture(canvas);
    t.anisotropy = 2;
    return t;
  }, [text, color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={position} scale={[scale, scale / 4, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}


// ── Shared clearing dressing: city grass + the city's own mountain ring ──────
const CITY_GRASS = "#7ec77f";

// The valley grass tufts, INSTANCED. Pixel-identical to GrassTuft() (1 base
// sphere + 7 cone blades = 8 meshes each) — every tuft's blades and bases fold
// into 2 draw calls across the whole arena. Same geometry, two-tone colours and
// per-tuft scale; transforms reproduce GrassTuft()'s exact local layout.
const TUFT_BLADES: [number, number, number, number][] = [
  [0, 0, 0, 0],
  [0.09, 0.05, 0.2, 1],
  [-0.08, 0.06, -0.24, 2],
  [0.04, -0.08, 0.16, 3],
  [-0.05, -0.05, -0.14, 4],
  [0.12, -0.02, 0.32, 5],
  [-0.11, 0.03, -0.34, 6],
];
function InstancedGrassTufts({ spots }: { spots: { pos: Vec3; s: number; color: string }[] }) {
  const pools = useMemo(() => {
    const bases: { p: Vec3; sc: Vec3; c: THREE.Color }[] = [];
    const blades: { p: Vec3; r: Vec3; sc: Vec3; c: THREE.Color }[] = [];
    for (const { pos, s, color } of spots) {
      const [px, py, pz] = pos;
      const base = new THREE.Color(color);
      const dark = new THREE.Color(color).multiplyScalar(0.78);
      bases.push({ p: [px, py + s * 0.02, pz], sc: [s * 0.16, s * 0.05, s * 0.16], c: dark });
      TUFT_BLADES.forEach(([x, z, tilt, i]) => {
        const h = 0.34 + (i % 3) * 0.09;
        blades.push({
          p: [px + s * x, py + s * (h / 2 + 0.02), pz + s * z],
          r: [tilt * 0.4, 0, tilt],
          sc: [s, s * h, s],
          c: i % 2 ? base : dark,
        });
      });
    }
    return { bases, blades };
  }, [spots]);
  return (
    <group>
      <Instances limit={pools.bases.length} range={pools.bases.length}>
        <sphereGeometry args={[1, 7, 5]} />
        <meshStandardMaterial roughness={1} flatShading />
        {pools.bases.map((b, i) => (
          <Instance key={i} position={b.p} scale={b.sc} color={b.c} />
        ))}
      </Instances>
      <Instances limit={pools.blades.length} range={pools.blades.length}>
        <coneGeometry args={[0.032, 1, 4]} />
        <meshStandardMaterial roughness={1} />
        {pools.blades.map((b, i) => (
          <Instance key={i} position={b.p} rotation={b.r} scale={b.sc} color={b.c} />
        ))}
      </Instances>
    </group>
  );
}

// Per-arena atmosphere: a real THREE.Fog depth cue while a mode is mounted —
// airy on the tower, warm over the course, thick and low over the graves. The
// world's own fog (if any) is restored on the way out.
function ArenaFog({ color, near, far }: { color: string; near: number; far: number }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const scene = get().scene;
    const prev = scene.fog;
    scene.fog = new THREE.Fog(color, near, far);
    return () => {
      get().scene.fog = prev;
    };
  }, [get, color, near, far]);
  return null;
}

function ArenaValley({ arena, charmClear = 26, mood = "day", avoid }: { arena: ArenaDef; charmClear?: number; mood?: "day" | "grim"; avoid?: (x: number, z: number) => boolean }) {
  const decor = useMemo(() => {
    const items: { kind: "tree" | "rock" | "bush" | "tuft" | "flowers"; pos: Vec3; s: number; v?: "round" | "pine" | "blossom" | "autumn" }[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      const r = arena.r - 3 - (i % 3) * 1.5;
      items.push({
        kind: i % 3 === 0 ? "tree" : i % 3 === 1 ? "rock" : "bush",
        pos: [arena.cx + Math.cos(a) * r, 0, arena.cz + Math.sin(a) * r],
        s: 0.85 + (i % 4) * 0.12,
        v: mood === "grim" ? "autumn" : i % 6 === 0 ? "blossom" : i % 6 === 3 ? "pine" : "round",
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = i * 2.399963; // golden angle — even spread
      const r = charmClear + (i % 14);
      if (r > arena.r - 4) continue;
      items.push({
        kind: mood === "grim" ? "tuft" : i % 4 === 0 ? "flowers" : "tuft",
        pos: [arena.cx + Math.cos(a) * r, 0.02, arena.cz + Math.sin(a) * r],
        s: 0.8 + (i % 3) * 0.25,
      });
    }
    // never drop scatter on courses or inside buildings
    return avoid ? items.filter((d) => !avoid(d.pos[0], d.pos[2])) : items;
  }, [arena, charmClear, mood, avoid]);

  return (
    <group>
      {/* valley floor — the city's exact grass, past the mountains */}
      <mesh position={[arena.cx, -0.05, arena.cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[arena.r + 260, 64]} />
        <meshStandardMaterial color={mood === "grim" ? "#6fae70" : CITY_GRASS} roughness={1} />
      </mesh>
      {/* the same mountain country that rings the city */}
      <group position={[arena.cx, 0, arena.cz]}>
        <BoundaryScenery extent={arena.r + 2} />
      </group>
      {decor.map((d, i) =>
        d.kind === "tree" ? (
          <Tree key={i} position={d.pos} scale={d.s} variant={d.v} />
        ) : d.kind === "rock" ? (
          <Rock key={i} position={d.pos} scale={d.s} />
        ) : d.kind === "bush" ? (
          <Bush key={i} position={d.pos} scale={d.s} />
        ) : d.kind === "flowers" ? (
          <Flowers key={i} position={d.pos} scale={d.s} />
        ) : null,
      )}
      {/* every grass tuft, batched into 2 draw calls */}
      <InstancedGrassTufts
        spots={decor
          .filter((d) => d.kind === "tuft")
          .map((d) => ({ pos: d.pos, s: d.s, color: mood === "grim" ? "#5f8f5f" : "#5aa85f" }))}
      />
      <Cloud position={[arena.cx - 26, 26, arena.cz - 18]} scale={1.6} />
      <Cloud position={[arena.cx + 24, 31, arena.cz + 10]} scale={1.2} />
      <Cloud position={[arena.cx - 6, 38, arena.cz + 26]} scale={1.9} />
    </group>
  );
}

// ── Sky Climb arena ───────────────────────────────────────────────────────────
// No slabs, no caps, no discs: the PROP TOP is the walking surface, sitting
// exactly at the collider height and spanning the collider's footprint. You
// stand on the flat of the boulder, the top of the haystack, the deck over the
// barrels — never on invisible geometry, never inside a prop.
const WOOD = "#7a5c34";
const WOOD_LIGHT = "#a9805a";

// The climb reads as three worlds as you rise — lush meadow, bare alpine
// stone, then pale wind-bleached sky-rock. Same platforms, shifting palette.
const CLIMB_PAL = [
  { grass: "#5fae64", rock: "#9d968a", rock2: "#8a8377", rock3: "#a8a294", earth: "#6b5744" },
  { grass: "#6f9e78", rock: "#8d949e", rock2: "#7a828c", rock3: "#9aa2ac", earth: "#5c5347" },
  { grass: "#9db8c8", rock: "#aab4c2", rock2: "#98a2b2", rock3: "#bcc6d4", earth: "#7a8294" },
];

function ClimbPlatform({ p, idx = 0, last }: { p: (typeof CLIMB)[number]; idx?: number; last: boolean }) {
  const r = Math.min(p.hw, p.hd) * 1.06;
  const gold = last ? "#ffd76b" : null;
  const sky = p.y > 62; // the dream band — crates and barrels become GIANT everyday objects
  const basePal = CLIMB_PAL[sky ? 2 : p.y > 30 ? 1 : 0];
  // subtle per-platform tint so 100 platforms don't read as 3 copies — a
  // deterministic ±6% shade keyed off the index, applied to the big surfaces.
  // Crumble ledges run darker — the seasoned eye learns to READ them.
  const v = (0.94 + ((idx * 7) % 4) * 0.04) * (p.crumble ? 0.86 : 1);
  const pal = {
    grass: shade(basePal.grass, v),
    rock: shade(basePal.rock, v),
    rock2: basePal.rock2,
    rock3: basePal.rock3,
    earth: shade(basePal.earth, v),
  };
  return (
    <group position={[p.x, p.y, p.z]}>
      {p.kind === "boulder" && (
        <group rotation={[0, p.x * 0.7, 0]}>
          {/* one big low-poly boulder, flattened — its top IS the platform */}
          <mesh position={[0, -r * 0.72, 0]} scale={[r * 1.0, r * 0.72, r * 1.0]} castShadow receiveShadow>
            <sphereGeometry args={[1, 8, 6]} />
            <meshStandardMaterial color={gold ?? pal.rock} roughness={1} flatShading />
          </mesh>
          <mesh position={[r * 0.5, -r * 0.98, -r * 0.3]} scale={r * 0.36} rotation={[0.4, 1.2, 0.2]}>
            <sphereGeometry args={[1, 6, 5]} />
            <meshStandardMaterial color={pal.rock2} roughness={1} flatShading />
          </mesh>
        </group>
      )}
      {p.kind === "grass" && (
        <>
          {/* a floating grass knoll — flat green top, earthen underside */}
          <mesh position={[0, -r * 0.62, 0]} scale={[r * 1.0, r * 0.66, r * 1.0]} castShadow receiveShadow>
            <sphereGeometry args={[1, 16, 10]} />
            <meshStandardMaterial color={gold ?? pal.grass} roughness={1} />
          </mesh>
          <mesh position={[0, -r * 0.95, 0]} scale={[r * 0.84, r * 0.6, r * 0.84]}>
            <sphereGeometry args={[1, 12, 8]} />
            <meshStandardMaterial color={pal.earth} roughness={1} flatShading />
          </mesh>
          {!p.rest && <GrassTuft position={[r * 0.22, -0.06, -r * 0.2]} scale={0.85} />}
        </>
      )}
      {p.kind === "hay" && (
        <group rotation={[0, p.z * 0.6, 0]}>
          {/* a proper haystack: wide base, flat trodden top at the collider */}
          <mesh position={[0, -0.8, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[r * 0.95, r * 1.0, 1.6, 14]} />
            <meshStandardMaterial color={gold ?? "#d9b45a"} roughness={1} />
          </mesh>
          {/* straw banding */}
          {[-0.5, -1.1].map((dy) => (
            <mesh key={dy} position={[0, dy, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[r * (0.95 - Math.abs(dy) * 0.05), 0.045, 6, 18]} />
              <meshStandardMaterial color="#b8923c" roughness={1} />
            </mesh>
          ))}
        </group>
      )}
      {p.kind === "log" && (
        <group rotation={[0, p.x * 0.9, 0]}>
          {/* one THICK felled trunk — wide enough that its curved top carries
              the whole footprint */}
          <mesh position={[0, -r * 0.78, 0]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
            <cylinderGeometry args={[r * 0.8, r * 0.86, r * 1.85, 14]} />
            <meshStandardMaterial color={gold ?? WOOD} roughness={0.95} />
          </mesh>
          {[-r * 0.93, r * 0.93].map((dx) => (
            <mesh key={dx} position={[dx, -r * 0.78, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[r * 0.74, r * 0.74, 0.08, 14]} />
              <meshStandardMaterial color="#c9a878" roughness={1} />
            </mesh>
          ))}
        </group>
      )}
      {p.kind === "crate" && sky && (
        <group rotation={[0, 0.35, 0]}>
          {/* a GIANT fallen book — its top cover is the platform */}
          <mesh position={[0, -0.06, 0]}>
            <boxGeometry args={[r * 1.88, 0.12, r * 1.88]} />
            <meshStandardMaterial color={gold ?? "#7a3b52"} roughness={0.8} />
          </mesh>
          <mesh position={[r * 0.04, -0.55, 0]} castShadow receiveShadow>
            <boxGeometry args={[r * 1.74, 0.86, r * 1.74]} />
            <meshStandardMaterial color="#efe9d8" roughness={1} />
          </mesh>
          {[-0.3, -0.55, -0.8].map((dy) => (
            <mesh key={dy} position={[r * 0.04, dy, 0]}>
              <boxGeometry args={[r * 1.76, 0.015, r * 1.76]} />
              <meshStandardMaterial color="#d8d2be" roughness={1} />
            </mesh>
          ))}
          <mesh position={[0, -1.04, 0]}>
            <boxGeometry args={[r * 1.88, 0.14, r * 1.88]} />
            <meshStandardMaterial color="#5f2e40" roughness={0.8} />
          </mesh>
          {/* spine + gilt title strip */}
          <mesh position={[-r * 0.9, -0.55, 0]}>
            <boxGeometry args={[0.12, 1.12, r * 1.88]} />
            <meshStandardMaterial color="#5f2e40" roughness={0.8} />
          </mesh>
          <mesh position={[-r * 0.97, -0.55, 0]}>
            <boxGeometry args={[0.02, 0.5, r * 0.6]} />
            <meshStandardMaterial color="#ffd76b" metalness={0.5} roughness={0.4} />
          </mesh>
        </group>
      )}
      {p.kind === "crate" && !sky && (
        <group rotation={[0, 0.4, 0]}>
          {/* the crate's LID is the platform */}
          <mesh position={[0, -0.75, 0]} castShadow receiveShadow>
            <boxGeometry args={[r * 1.9, 1.5, r * 1.9]} />
            <meshStandardMaterial color={gold ?? WOOD_LIGHT} roughness={0.9} />
          </mesh>
          {/* lid planks */}
          {[-0.6, 0, 0.6].map((dz) => (
            <mesh key={dz} position={[0, -0.02, dz * r]}>
              <boxGeometry args={[r * 1.92, 0.05, r * 0.5]} />
              <meshStandardMaterial color="#997248" roughness={0.95} />
            </mesh>
          ))}
        </group>
      )}
      {p.kind === "barrel" && sky && (
        <group>
          {/* a GIANT storm lantern — you land on its metal cap */}
          <mesh position={[0, -0.08, 0]}>
            <cylinderGeometry args={[r * 0.95, r * 1.0, 0.16, 12]} />
            <meshStandardMaterial color={gold ?? "#3a3f47"} metalness={0.5} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.04, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[r * 0.22, 0.05, 6, 12]} />
            <meshStandardMaterial color="#2f343b" metalness={0.5} roughness={0.5} />
          </mesh>
          {/* the glass — a warm beacon you can see from the meadow below */}
          <mesh position={[0, -0.75, 0]}>
            <cylinderGeometry args={[r * 0.78, r * 0.86, 1.2, 10]} />
            <meshStandardMaterial color="#ffe9b0" emissive="#ffb35e" emissiveIntensity={0.55} transparent opacity={0.55} />
          </mesh>
          {[0, 1.05, 2.1, 3.15, 4.2, 5.25].map((a) => (
            <mesh key={a} position={[Math.cos(a) * r * 0.84, -0.75, Math.sin(a) * r * 0.84]}>
              <boxGeometry args={[0.08, 1.32, 0.08]} />
              <meshStandardMaterial color="#2f343b" metalness={0.4} roughness={0.6} />
            </mesh>
          ))}
          <mesh position={[0, -1.45, 0]}>
            <cylinderGeometry args={[r * 0.95, r * 1.0, 0.2, 12]} />
            <meshStandardMaterial color="#3a3f47" metalness={0.5} roughness={0.5} />
          </mesh>
          <pointLight position={[0, -0.75, 0]} color="#ffcf8e" intensity={1.6} distance={7} />
        </group>
      )}
      {p.kind === "barrel" && !sky && (
        <group rotation={[0, p.z * 0.5, 0]}>
          {/* a planked deck laid over the barrels — the deck is the platform */}
          <mesh position={[0, -0.12, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[r * 1.02, r * 1.02, 0.1, 16]} />
            <meshStandardMaterial color={gold ?? WOOD} roughness={0.95} />
          </mesh>
          {[-0.55, 0, 0.55].map((dz) => (
            <mesh key={dz} position={[0, -0.03, dz * r]}>
              <boxGeometry args={[r * 1.9, 0.06, r * 0.42]} />
              <meshStandardMaterial color={gold ?? WOOD_LIGHT} roughness={0.9} />
            </mesh>
          ))}
          <Barrel position={[-r * 0.45, -1.12, 0]} />
          <Barrel position={[r * 0.48, -1.12, r * 0.3]} rotation={1.2} />
          <Barrel position={[0, -1.12, -r * 0.48]} rotation={0.6} />
          <Barrel position={[r * 0.05, -1.12, r * 0.05]} rotation={2.1} />
          {/* iron strapping under the deck lip */}
          <mesh position={[0, -0.15, 0]} rotation={[Math.PI / 2, 0, Math.PI / 8]}>
            <torusGeometry args={[r * 1.0, 0.04, 6, 8]} />
            <meshStandardMaterial color="#3a3f47" metalness={0.5} roughness={0.5} />
          </mesh>
        </group>
      )}
      {p.kind === "cart" && (
        <group rotation={[0, p.x * 0.8, 0]}>
          {/* a pallet strapped over the cart — the pallet is the platform */}
          <mesh position={[0, -0.1, 0]} castShadow receiveShadow>
            <boxGeometry args={[r * 1.85, 0.12, r * 1.85]} />
            <meshStandardMaterial color={gold ?? WOOD} roughness={0.95} />
          </mesh>
          {[-0.6, 0, 0.6].map((dx) => (
            <mesh key={dx} position={[dx * r, 0.0, 0]}>
              <boxGeometry args={[r * 0.45, 0.07, r * 1.97]} />
              <meshStandardMaterial color={WOOD_LIGHT} roughness={0.9} />
            </mesh>
          ))}
          <Cart position={[0, -1.05, 0]} rotation={0} />
        </group>
      )}
      {p.rest && (
        <group position={[r * 0.3, -0.04, r * 0.3]}>
          {/* a waymark cairn — stacked stones, like hikers leave */}
          <mesh position={[0, 0.16, 0]} scale={[0.3, 0.28, 0.3]}><sphereGeometry args={[1, 6, 5]} /><meshStandardMaterial color="#9d968a" roughness={1} flatShading /></mesh>
        </group>
      )}
      {p.rest && <GrassTuft position={[-r * 0.3, -0.04, r * 0.18]} scale={1.05} />}
      {p.crumble && (
        // the tell: hairline fracture lines across the walking surface
        <group position={[0, 0.03, 0]}>
          <mesh rotation={[0, 0.6, 0]}>
            <boxGeometry args={[r * 1.7, 0.02, 0.05]} />
            <meshStandardMaterial color="#3d382f" roughness={1} />
          </mesh>
          <mesh rotation={[0, -0.9, 0]} position={[r * 0.15, 0, -r * 0.1]}>
            <boxGeometry args={[r * 1.3, 0.02, 0.04]} />
            <meshStandardMaterial color="#463f34" roughness={1} />
          </mesh>
        </group>
      )}
    </group>
  );
}


const CRUMBLE_REGROW_MS = 12_000; // a broken ledge grows back — the route heals

// The climb's air, by altitude: meadow haze at the base → thin bright air at the
// summit. Preallocated — lerped every frame, never rebuilt.
const CLIMB_FOG_LO = new THREE.Color("#cfe2f2");
const CLIMB_FOG_HI = new THREE.Color("#eaf3fd");
const CLIMB_FOG_MIX = new THREE.Color();

// ── Gusts: above the treeline, the daily wind SHOVES ─────────────────────────
// The Player reads this store every airborne frame (zero unless the climb is
// mounted and a gust is live — same mutate-in-place pattern as ZOMBIE_GAIT).
// The schedule is deterministic from the daily seed: everyone climbs the same
// weather, and a gust telegraphs itself a second early — the wind loop swells
// and the summit pennant snaps to the incoming direction.
export const CLIMB_GUST = { vx: 0, vz: 0 };
const GUST_PERIOD = 7.0; // seconds per cycle
const GUST_LEN = 1.4; // how long the shove lasts
const GUST_LEAD = 1.0; // the telegraph second before it
const GUST_MIN_H = 26; // below this height the meadow shelters you
const GUST_PUSH = 3.4; // peak lateral m/s
const hash01 = (n: number): number => {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export function ClimbArena({ poseRef, nonce = 0 }: { poseRef?: { current: { x: number; z: number; h?: number } }; nonce?: number }) {
  const flag = useRef<THREE.Group>(null);
  const summitRing = useRef<THREE.Mesh>(null);
  const padRing = useRef<THREE.Mesh>(null);
  const get = useThree((s) => s.get);
  const daySeed = useMemo(() => dailySeed(), []); // pinned per mount — no reseed at UTC midnight mid-run
  // ── the wind: a filtered-noise loop that rises with you (see WindLoop) ──────
  useEffect(() => {
    worldWind.start();
    return () => {
      worldWind.stop();
      CLIMB_GUST.vx = 0; // leaving the climb stills the air
      CLIMB_GUST.vz = 0;
    };
  }, []);
  // ── crumble ledges: stand too long and the stone lets go under you ──────────
  const crumbleRefs = useRef<Map<number, THREE.Group | null>>(new Map());
  const crumbleState = useRef<Map<number, { origY: number; armAt: number; fellAt: number; puffed: boolean }>>(new Map());
  useEffect(() => {
    const st = crumbleState.current;
    CLIMB.forEach((p, i) => {
      if (p.crumble) st.set(i, { origY: p.y, armAt: 0, fellAt: 0, puffed: false });
    });
    return () => {
      // leave the shared course whole for the next visitor
      for (const [i, s] of st) setClimbPlatY(i, s.origY);
      st.clear();
    };
  }, []);
  // Restart wipes the day's damage: a fresh timer deserves a whole course, not
  // one with 12s of regrow-holes left by the previous attempt.
  useEffect(() => {
    for (const [i, s] of crumbleState.current) {
      Object.assign(s, { armAt: 0, fellAt: 0, puffed: false });
      setClimbPlatY(i, s.origY);
      const grp = crumbleRefs.current.get(i);
      if (grp) {
        grp.position.y = 0;
        grp.rotation.z = 0;
        grp.visible = true;
      }
    }
  }, [nonce]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (flag.current) flag.current.rotation.y = Math.sin(t * 1.6) * 0.18;
    // the golden ring turns slowly around the summit; the reset ring breathes
    if (summitRing.current) summitRing.current.rotation.z = t * 0.4;
    if (padRing.current) {
      const k = 1 + Math.sin(t * 2.4) * 0.06;
      padRing.current.scale.set(k, k, 1);
    }
    // crumble life-cycle: arm (wobble + crack) → fall (collider gone) → regrow
    const p = poseRef?.current;
    if (!p) return;
    const now = Date.now();
    // ── altitude atmosphere: the air thins as you climb — the fog brightens and
    // closes in, and the wind loop rises with you. Height IS felt, not just seen.
    const alt = Math.max(0, Math.min(1, (p.h ?? 0) / SUMMIT.y));
    const fog = get().scene.fog as THREE.Fog | null;
    if (fog && "near" in fog) {
      CLIMB_FOG_MIX.copy(CLIMB_FOG_LO).lerp(CLIMB_FOG_HI, alt);
      fog.color.lerp(CLIMB_FOG_MIX, 0.08);
      fog.near += (90 - alt * 26 - fog.near) * 0.08;
      fog.far += (420 - alt * 80 - fog.far) * 0.08;
    }
    // ── the gust cycle: lead second (wind swells, pennant snaps to the incoming
    // direction) → the shove itself (Player physics reads CLIMB_GUST) → calm
    const cyc = Math.floor(t / GUST_PERIOD);
    const ph = t - cyc * GUST_PERIOD;
    const active = ph < GUST_LEN;
    const leading = ph > GUST_PERIOD - GUST_LEAD;
    const dirNow = hash01(daySeed * 31 + cyc) * Math.PI * 2;
    const dirNext = hash01(daySeed * 31 + cyc + 1) * Math.PI * 2;
    const inBand = (p.h ?? 0) > GUST_MIN_H;
    const gustK = active && inBand ? Math.sin((ph / GUST_LEN) * Math.PI) : 0;
    CLIMB_GUST.vx = Math.cos(dirNow) * gustK * GUST_PUSH;
    CLIMB_GUST.vz = Math.sin(dirNow) * gustK * GUST_PUSH;
    worldWind.set(Math.min(1, alt + ((leading || active) && inBand ? 0.35 : 0)));
    // the pennant IS the wind sock: it snaps to the gust a second before it hits
    if (flag.current) {
      const wave = Math.sin(t * (active ? 9 : 1.6)) * (active ? 0.1 : 0.18);
      const targetY = active ? -dirNow + wave : leading ? -dirNext + wave : wave;
      const cur = flag.current.rotation.y;
      let dY = targetY - cur;
      dY = Math.atan2(Math.sin(dY), Math.cos(dY));
      flag.current.rotation.y = cur + dY * 0.14;
    }
    for (const [i, s] of crumbleState.current) {
      const plat = CLIMB[i];
      const grp = crumbleRefs.current.get(i);
      if (s.fellAt) {
        const k = (now - s.fellAt) / 1000;
        if (grp) {
          grp.position.y = -k * k * 9;
          grp.rotation.z = k * 0.35;
          grp.visible = k < 1.1;
        }
        if (now - s.fellAt > CRUMBLE_REGROW_MS) {
          Object.assign(s, { fellAt: 0, armAt: 0 });
          setClimbPlatY(i, s.origY);
          if (grp) {
            grp.position.y = 0;
            grp.rotation.z = 0;
            grp.visible = true;
          }
        }
        continue;
      }
      const h = p.h ?? 0;
      const standing =
        Math.abs(p.x - plat.x) < plat.hw + 0.35 &&
        Math.abs(p.z - plat.z) < plat.hd + 0.35 &&
        h > plat.y - 0.4 &&
        h < plat.y + 1.6;
      if (standing) {
        if (!s.armAt) {
          Object.assign(s, { armAt: now, puffed: false });
          worldSfx.crack(); // the warning — GO
        }
        // the telegraph ESCALATES: the wobble grows over the 800ms so the ledge
        // visibly loses its nerve, and halfway in it sheds a first trickle of
        // dust — you're warned by eye and ear before the ground goes
        const armK = Math.min(1, (now - s.armAt) / 800);
        if (grp) {
          grp.rotation.z = Math.sin(now * 0.045) * (0.018 + armK * 0.055);
          grp.position.y = -Math.min(0.12, (now - s.armAt) / 6000);
        }
        if (!s.puffed && now - s.armAt > 420) {
          Object.assign(s, { puffed: true });
          arcadeFx.crumble(plat.x, plat.y - 0.25, plat.z, Math.min(plat.hw, plat.hd) * 0.45);
        }
        if (now - s.armAt > 800) {
          Object.assign(s, { fellAt: now });
          worldSfx.crack();
          arcadeFx.crumble(plat.x, plat.y, plat.z, Math.min(plat.hw, plat.hd));
          arcadeShake.add(0.2); // it let go UNDER YOU — the camera feels it
          setClimbPlatY(i, -999); // the collider vanishes — physics reads this array live
        }
      } else if (s.armAt) {
        Object.assign(s, { armAt: 0, puffed: false });
        if (grp) {
          grp.rotation.z = 0;
          grp.position.y = 0;
        }
      }
    }
  });
  const g = ARENAS.climb;
  return (
    <group>
      <ArenaValley arena={g} charmClear={26} />
      {/* the spire — a segmented rock column (SOLID: the player can't pass
          through it) rising off a rocky base mound, moss on the ledges */}
      <mesh position={[g.cx, 0.35, g.cz]} scale={[5.8, 2.2, 5.8]}>
        <sphereGeometry args={[1, 9, 6]} />
        <meshStandardMaterial color="#8a8371" roughness={1} flatShading />
      </mesh>
      {/* ONE straight tapered shaft — perfectly plumb, banded by tone */}
      {Array.from({ length: 6 }, (_, i) => {
        const h0 = (i / 6) * (SUMMIT.y + 1);
        const h1 = ((i + 1) / 6) * (SUMMIT.y + 1);
        const rB = 2.7 - (h0 / (SUMMIT.y + 1)) * 0.5;
        const rT = 2.7 - (h1 / (SUMMIT.y + 1)) * 0.5;
        return (
          <mesh key={i} position={[g.cx, (h0 + h1) / 2, g.cz]}>
            <cylinderGeometry args={[rT, rB, h1 - h0 + 0.05, 12]} />
            <meshStandardMaterial color={i % 2 ? "#98917f" : "#918a77"} roughness={1} flatShading />
          </mesh>
        );
      })}
      {[0.25, 0.55, 0.8].map((k, i) => (
        <mesh
          key={`moss${i}`}
          position={[g.cx + Math.sin(i * 2.8) * 2.2, (SUMMIT.y + 1) * k, g.cz + Math.cos(i * 2.2) * 2.2]}
          scale={[0.9, 0.5, 0.9]}
        >
          <sphereGeometry args={[1, 7, 5]} />
          <meshStandardMaterial color="#5f8f5f" roughness={1} flatShading />
        </mesh>
      ))}
      <mesh position={[g.cx, SUMMIT.y + 1.1, g.cz]}>
        <cylinderGeometry args={[2.9, 2.4, 0.5, 9]} />
        <meshStandardMaterial color="#8a8371" roughness={1} flatShading />
      </mesh>
      <ArenaFog color="#cfe2f2" near={90} far={420} />
      {CLIMB.map((p, i) =>
        p.crumble ? (
          // crumble ledges live in an animatable wrapper — wobble, drop, regrow
          <group key={i} ref={(el) => { crumbleRefs.current.set(i, el); }}>
            <ClimbPlatform p={p} idx={i} last={false} />
          </group>
        ) : (
          <ClimbPlatform key={i} p={p} idx={i} last={i === CLIMB.length - 1} />
        ),
      )}
      {/* THE SUMMIT — a real prize, not a plane: banded pole, gold topper, a
          two-tone pennant that waves, a slow golden halo ring and a light beam
          you can sight from the meadow floor */}
      <group position={[SUMMIT.x, SUMMIT.y, SUMMIT.z]}>
        <mesh position={[0, 1.6, 0]}>
          <cylinderGeometry args={[0.06, 0.09, 3.2, 8]} />
          <meshStandardMaterial color="#5b4632" roughness={0.9} />
        </mesh>
        <mesh position={[0, 3.28, 0]}>
          <sphereGeometry args={[0.14, 10, 8]} />
          <meshStandardMaterial color="#ffd76b" emissive="#ffb35e" emissiveIntensity={0.8} metalness={0.4} roughness={0.3} />
        </mesh>
        <group ref={flag} position={[0, 2.7, 0]}>
          {/* two-tone pennant: teal body + gold tail triangle */}
          <mesh position={[0.55, 0, 0]}>
            <planeGeometry args={[1.05, 0.62]} />
            <meshStandardMaterial color="#14b8a6" emissive="#14b8a6" emissiveIntensity={0.35} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[1.22, 0, 0]} rotation={[0, 0, Math.PI / 4]}>
            <planeGeometry args={[0.44, 0.44]} />
            <meshStandardMaterial color="#ffd76b" emissive="#ffd76b" emissiveIntensity={0.3} side={THREE.DoubleSide} />
          </mesh>
        </group>
        {/* the halo — a slow golden ring floating over the cap */}
        <mesh ref={summitRing} position={[0, 4.6, 0]} rotation={[Math.PI / 2.4, 0, 0]}>
          <torusGeometry args={[1.5, 0.05, 8, 40]} />
          <meshStandardMaterial color="#ffd76b" emissive="#ffcf5e" emissiveIntensity={0.9} toneMapped={false} transparent opacity={0.85} />
        </mesh>
        {/* the beacon — a faint light column visible from the ground */}
        <mesh position={[0, 16, 0]}>
          <cylinderGeometry args={[0.5, 1.1, 32, 10, 1, true]} />
          <meshBasicMaterial color="#ffe9b0" transparent opacity={0.07} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
        <pointLight position={[0, 2.6, 0]} color="#2dd4bf" intensity={5} distance={12} />
        <Label text="SUMMIT" position={[0, 4.2, 0]} color="#ffd76b" scale={2.8} />
      </group>
      <Label text="START" position={[CLIMB[0].x, CLIMB[0].y + 2.0, CLIMB[0].z]} scale={2.6} />
      {/* SPRINGBOARDS — the daily route's three risk/reward launches: a coiled
          plank on the platform rim; step on and it flings you past a hop or two */}
      {CLIMB_SPRINGS.map((sp, i) => (
        <group key={`spring${i}`} position={[sp.x, sp.y, sp.z]}>
          {[0.1, 0.22].map((hy, k) => (
            <mesh key={k} position={[0, hy, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[sp.r * 0.5, 0.05, 6, 16]} />
              <meshStandardMaterial color="#8a5a2a" roughness={0.7} metalness={0.2} />
            </mesh>
          ))}
          <mesh position={[0, 0.32, 0]}>
            <cylinderGeometry args={[sp.r * 0.72, sp.r * 0.66, 0.09, 12]} />
            <meshStandardMaterial color="#c9a24b" emissive="#a97c2c" emissiveIntensity={0.25} roughness={0.75} />
          </mesh>
          <Label text="SPRING" position={[0, 1.2, 0]} color="#ffd76b" scale={1.2} />
        </group>
      ))}
      {/* THE RESET PAD — no checkpoints up there and the clock never stops for a
          fall; this stone circle by the start is the one way to wipe the run.
          Reads at a glance: pale stone disc, breathing amber ring, its own sign. */}
      <group position={[CLIMB_RESET.x, 0, CLIMB_RESET.z]}>
        <mesh position={[0, 0.05, 0]}>
          <cylinderGeometry args={[CLIMB_RESET.r, CLIMB_RESET.r + 0.25, 0.12, 24]} />
          <meshStandardMaterial color="#b8b3a6" roughness={1} />
        </mesh>
        <mesh position={[0, 0.045, 0]}>
          <cylinderGeometry args={[CLIMB_RESET.r * 0.55, CLIMB_RESET.r * 0.6, 0.14, 20]} />
          <meshStandardMaterial color="#9d968a" roughness={1} />
        </mesh>
        <mesh ref={padRing} position={[0, 0.14, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[CLIMB_RESET.r * 0.78, CLIMB_RESET.r * 0.92, 36]} />
          <meshStandardMaterial color="#ffb35e" emissive="#ff8c2e" emissiveIntensity={0.7} toneMapped={false} transparent opacity={0.75} depthWrite={false} />
        </mesh>
        <Label text="RESET RUN" position={[0, 1.6, 0]} color="#ffb35e" scale={1.9} />
      </group>
    </group>
  );
}

// The pond reeds, INSTANCED. Pixel-identical to placing 30 <Reed> components
// (each ~16 meshes = ~480 draw calls) — every stalk, seed-head, tip and leaf
// blade across all ponds folds into 4 instanced draw calls. Same geometry,
// colours and per-reed scale; the transforms below reproduce Reed()'s exact
// local layout in world space.
const REED_STALKS: [number, number, number, number][] = [
  [-0.12, -0.07, -0.14, 1],
  [0.05, 0.03, 0.04, 0.82],
  [0.14, 0.08, 0.16, 1.08],
  [-0.02, 0.12, -0.05, 0.68],
];
const REED_LEAF_A = [0.6, 2.1, 3.5, 5.0];
function InstancedReeds({ spots }: { spots: { x: number; z: number; s: number }[] }) {
  const pools = useMemo(() => {
    const cyls: { p: Vec3; r: Vec3; sc: Vec3; c: string }[] = [];
    const heads: { p: Vec3; r: Vec3; sc: Vec3 }[] = [];
    const tips: { p: Vec3; r: Vec3; sc: Vec3 }[] = [];
    const leaves: { p: Vec3; r: Vec3; sc: Vec3 }[] = [];
    for (const { x: rx, z: rz, s } of spots) {
      REED_STALKS.forEach(([x, z, lean, h], i) => {
        const sinL = Math.sin(lean), cosL = Math.cos(lean);
        const mk = (cy: number): Vec3 => [rx + s * (x - cy * sinL), s * cy * cosL, rz + s * z];
        cyls.push({ p: mk(0.7 * h), r: [0, 0, lean], sc: [s, s * h, s], c: i % 2 ? "#5a9e4a" : "#6bab55" });
        heads.push({ p: mk(1.48 * h), r: [0, 0, lean], sc: [s, s, s] });
        tips.push({ p: mk(1.72 * h), r: [0, 0, lean], sc: [s, s, s] });
      });
      REED_LEAF_A.forEach((a) => {
        leaves.push({
          p: [rx + s * Math.cos(a) * 0.16, s * 0.42, rz + s * Math.sin(a) * 0.16],
          r: [Math.cos(a) * 0.55, -a, Math.sin(a) * 0.55],
          sc: [s * 0.5, s, s * 0.16],
        });
      });
    }
    return { cyls, heads, tips, leaves };
  }, [spots]);
  return (
    <group>
      <Instances limit={pools.cyls.length} range={pools.cyls.length}>
        <cylinderGeometry args={[0.026, 0.038, 1.4, 5]} />
        <meshStandardMaterial roughness={0.9} />
        {pools.cyls.map((c, i) => (
          <Instance key={i} position={c.p} rotation={c.r} scale={c.sc} color={c.c} />
        ))}
      </Instances>
      <Instances limit={pools.heads.length} range={pools.heads.length}>
        <capsuleGeometry args={[0.06, 0.26, 4, 6]} />
        <meshStandardMaterial color="#7a4a24" roughness={0.95} />
        {pools.heads.map((c, i) => (
          <Instance key={i} position={c.p} rotation={c.r} scale={c.sc} />
        ))}
      </Instances>
      <Instances limit={pools.tips.length} range={pools.tips.length}>
        <cylinderGeometry args={[0.012, 0.012, 0.16, 4]} />
        <meshStandardMaterial color="#d9c47a" roughness={0.9} />
        {pools.tips.map((c, i) => (
          <Instance key={i} position={c.p} rotation={c.r} scale={c.sc} />
        ))}
      </Instances>
      <Instances limit={pools.leaves.length} range={pools.leaves.length}>
        <coneGeometry args={[0.07, 0.95, 4]} />
        <meshStandardMaterial color="#6fae54" roughness={0.9} />
        {pools.leaves.map((c, i) => (
          <Instance key={i} position={c.p} rotation={c.r} scale={c.sc} />
        ))}
      </Instances>
    </group>
  );
}

// The live run's checkpoint progress — written by GauntletHazards, read by the
// arena's beacon so the flag you'd return to is always marked. Module scope,
// same mutate-in-place pattern as ZOMBIE_GAIT.
export const GAUNTLET_LIVE = { cpIdx: 0 };

// ── The Gauntlet arena ────────────────────────────────────────────────────────
export function GauntletArena() {
  const g = ARENAS.gauntlet;
  const arms = useRef<(THREE.Group | null)[]>([]);
  const ripples = useRef<(THREE.Mesh | null)[]>([]);
  const cpFlags = useRef<(THREE.Group | null)[]>([]);
  const stomperHeads = useRef<(THREE.Group | null)[]>([]);
  const stomperShadows = useRef<(THREE.Mesh | null)[]>([]);
  const beacon = useRef<THREE.Group>(null);
  const beaconRing = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    // the SAME parametric motion the collision check uses — visual == hitbox
    const t = state.clock.elapsedTime;
    GAUNTLET_SWEEPERS.forEach((s, i) => {
      const el = arms.current[i];
      if (el) el.rotation.y = -(t * s.w + s.phase);
    });
    // stomper heads ride the SAME height function the crush check reads
    GAUNTLET_STOMPERS.forEach((s, i) => {
      const el = stomperHeads.current[i];
      if (el) el.position.y = stomperHeadY(s, t);
    });
    // the crusher's TELL: a shadow pools under the head in the last beat of the
    // hang, sits dark while it's planted, and lifts as it winches away — you
    // read the slam coming instead of memorising the timing
    GAUNTLET_STOMPERS.forEach((s, i) => {
      const el = stomperShadows.current[i];
      if (!el) return;
      const c = ((t + s.phase) / s.period) % 1;
      const m = el.material as THREE.MeshBasicMaterial;
      m.opacity =
        c < 0.56 ? 0
        : c < 0.66 ? ((c - 0.56) / 0.1) * 0.42
        : c < 0.9 ? 0.46
        : 0.46 * (1 - (c - 0.9) / 0.1);
      el.scale.setScalar(c >= 0.56 && c < 0.66 ? 0.68 + ((c - 0.56) / 0.1) * 0.47 : 1.15);
    });
    // the beacon rides the checkpoint you OWN — after any reset, your anchor is
    // the lit pillar on the horizon
    const bEl = beacon.current;
    if (bEl) {
      const cp = GAUNTLET_CHECKPOINTS[Math.min(GAUNTLET_LIVE.cpIdx, GAUNTLET_CHECKPOINTS.length - 1)];
      bEl.position.set(cp.x, 0, cp.z);
      if (beaconRing.current) {
        const k = 1 + Math.sin(t * 2.6) * 0.08;
        beaconRing.current.scale.set(k, k, 1);
      }
    }
    // pond ripples: rings breathe outward and fade
    ripples.current.forEach((el, i) => {
      if (!el) return;
      const k = ((t * 0.35 + i * 0.37) % 1);
      el.scale.setScalar(0.35 + k * 0.85);
      const m = el.material as THREE.MeshStandardMaterial;
      m.opacity = 0.35 * (1 - k);
    });
    // checkpoint flags flutter
    cpFlags.current.forEach((el, i) => {
      if (el) el.rotation.y = Math.sin(t * 3.1 + i * 1.7) * 0.35;
    });
  });
  const fenceFlags = useMemo(() => {
    const posts: { x: number; z: number }[] = [];
    for (let x = -84; x <= 84; x += 9.5) {
      posts.push({ x: g.cx + x, z: g.cz - LANE_OFF - LANE_HALF - 1.3 }); // south outer
      posts.push({ x: g.cx + x, z: g.cz + LANE_OFF + LANE_HALF + 1.3 }); // north outer
    }
    return posts;
  }, [g]);
  const reedSpots = useMemo(() => {
    const spots: { x: number; z: number; s: number }[] = [];
    for (const pond of GAUNTLET_PONDS) {
      const w = pond.x2 - pond.x1;
      for (let i = 0; i < 5; i++) {
        spots.push({ x: pond.x1 + 0.6 + i * (w / 5), z: i % 2 ? pond.z1 + 0.5 : pond.z2 - 0.5, s: 0.9 + (i % 3) * 0.2 });
      }
    }
    return spots;
  }, []);
  return (
    <group>
      <ArenaValley arena={g} charmClear={34} avoid={(x, z) => Math.abs(z - g.cz) < LANE_OFF + LANE_HALF + 15 && Math.abs(x - g.cx) < 104} />
      <ArenaFog color="#e2e8cf" near={110} far={460} />
      {/* the crusher tells — ground shadows that pool before each slam */}
      {GAUNTLET_STOMPERS.map((s, i) => (
        <mesh
          key={`ssh${i}`}
          ref={(el) => { stomperShadows.current[i] = el; }}
          position={[s.x, 0.025, s.z]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <circleGeometry args={[1.35, 20]} />
          <meshBasicMaterial color="#191309" transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
      {/* YOUR checkpoint — a teal light pillar on the flag a reset returns you to */}
      <group ref={beacon}>
        <mesh position={[0, 4.4, 0]}>
          <cylinderGeometry args={[0.34, 0.85, 8.8, 10, 1, true]} />
          <meshBasicMaterial color="#2dd4bf" transparent opacity={0.09} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
        <mesh ref={beaconRing} position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.12, 1.42, 26]} />
          <meshBasicMaterial color="#2dd4bf" transparent opacity={0.45} depthWrite={false} />
        </mesh>
        <pointLight position={[0, 2.2, 0]} color="#2dd4bf" intensity={1.6} distance={9} />
      </group>
      {/* SPEED PADS — teal chevron strips that reward the clean racing line */}
      {GAUNTLET_SPEED_PADS.map((sp, i) => (
        <group key={`spd${i}`} position={[sp.x, 0.03, sp.z]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[sp.hw * 2, sp.hd * 2]} />
            <meshStandardMaterial color="#0f766e" emissive="#0d9488" emissiveIntensity={0.3} transparent opacity={0.45} depthWrite={false} />
          </mesh>
          {[-1.7, 0, 1.7].map((dx, k) => (
            <mesh key={k} position={[dx * sp.dir, 0.012, 0]} rotation={[-Math.PI / 2, 0, sp.dir > 0 ? 0 : Math.PI]}>
              <circleGeometry args={[0.62, 3]} />
              <meshBasicMaterial color="#5eead4" transparent opacity={0.75} depthWrite={false} />
            </mesh>
          ))}
        </group>
      ))}
      {/* THREE packed-dirt legs + the two hairpin aprons that join them */}
      {[-1, 0, 1].map((side) => (
        <mesh key={`lane${side}`} position={[g.cx, 0.005, g.cz + side * LANE_OFF]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[178, LANE_HALF * 2 + 2]} />
          <meshStandardMaterial color="#cbb98e" roughness={1} />
        </mesh>
      ))}
      {GAUNTLET_TURNS.map((turn, ti) => {
        const dir = ti === 0 ? 1 : -1; // east turn opens west, west turn opens east
        return (
          <group key={`turn${ti}`} position={[turn.x, 0, turn.z]}>
            {/* the apron — lifted clear of the lane planes so the two flats
                can't shimmer against each other at distance */}
            <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[11.5, 32]} />
              <meshStandardMaterial color="#c4b285" roughness={1} />
            </mesh>
            {/* painted turning arrows curling through the hairpin */}
            {[-0.7, 0, 0.7].map((aa, i) => (
              <mesh key={`arr${i}`} position={[dir * (9 - Math.abs(aa) * 2.5), 0.03, aa * 8]} rotation={[-Math.PI / 2, aa * dir, 0]}>
                <planeGeometry args={[2.8, 0.8]} />
                <meshStandardMaterial color="#e07a5f" transparent opacity={0.75} roughness={1} depthWrite={false} />
              </mesh>
            ))}
            {/* stone balustrade guarding the outer rim of the turn */}
            {[-0.9, -0.45, 0, 0.45, 0.9].map((aa, i) => (
              <group key={`bal${i}`} position={[dir * Math.cos(aa) * 10.6, 0, Math.sin(aa) * 10.6]}>
                <mesh position={[0, 0.55, 0]}>
                  <cylinderGeometry args={[0.28, 0.36, 1.1, 8]} />
                  <meshStandardMaterial color="#9a948a" roughness={1} flatShading />
                </mesh>
                <mesh position={[0, 1.16, 0]}>
                  <boxGeometry args={[0.7, 0.16, 0.7]} />
                  <meshStandardMaterial color="#8a857b" roughness={1} />
                </mesh>
              </group>
            ))}
            {/* the divider-end pillar — a rounded hedge cap you swing around
                (the west pivot sits further out past leg 2's last hurdles, so
                its divider end is 18.5 back toward the course) */}
            <group position={[ti === 0 ? -8.5 : 18.5, 0, 0]}>
              <mesh position={[0, 0.95, 0]}>
                <cylinderGeometry args={[1.2, 1.35, 1.9, 10]} />
                <meshStandardMaterial color="#3e7a48" roughness={1} />
              </mesh>
              <mesh position={[0, 2.0, 0]} scale={[1.35, 0.55, 1.35]}>
                <sphereGeometry args={[1, 10, 8]} />
                <meshStandardMaterial color="#478a52" roughness={1} />
              </mesh>
            </group>
          </group>
        );
      })}
      {/* start + finish arches — crossbar SPANS the poles, gate faces the lane */}
      {[
        { b: GAUNTLET_START, label: "START", c: "#14b8a6" },
        { b: GAUNTLET_FINISH, label: "FINISH", c: "#ffd76b" },
      ].map(({ b, label, c }) => (
        <group key={label} position={[b.x, 0, b.z]}>
          {[-LANE_HALF, LANE_HALF].map((dz) => (
            <mesh key={dz} position={[0, 1.7, dz]}>
              <cylinderGeometry args={[0.14, 0.17, 3.4, 8]} />
              <meshStandardMaterial color="#5b4632" roughness={0.9} />
            </mesh>
          ))}
          <mesh position={[0, 3.4, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.09, 0.09, LANE_HALF * 2, 8]} />
            <meshStandardMaterial color="#5b4632" roughness={0.9} />
          </mesh>
          {/* bunting along the crossbar — festival three-colour cycle */}
          {[-3, -1.5, 0, 1.5, 3].map((dz, i) => (
            <mesh key={dz} position={[0, 3.22, dz]} rotation={[Math.PI, 0, 0]}>
              <coneGeometry args={[0.14, 0.34, 3]} />
              <meshStandardMaterial color={["#14b8a6", "#f4e6c8", "#e07a5f"][i % 3]} roughness={0.8} />
            </mesh>
          ))}
          <Label text={label} position={[0, 4.5, 0]} color={c} scale={3.2} />
        </group>
      ))}
      {/* lane-side flag posts — INSTANCED: ~36 posts + flags → 2 draw calls */}
      <Instances limit={fenceFlags.length} range={fenceFlags.length}>
        <cylinderGeometry args={[0.05, 0.07, 1.6, 6]} />
        <meshStandardMaterial color="#7a5c34" roughness={0.9} />
        {fenceFlags.map((f, i) => (
          <Instance key={i} position={[f.x, 0.8, f.z]} />
        ))}
      </Instances>
      <Instances limit={fenceFlags.length} range={fenceFlags.length}>
        <planeGeometry args={[0.44, 0.28]} />
        <meshStandardMaterial side={THREE.DoubleSide} />
        {fenceFlags.map((f, i) => (
          <Instance key={i} color={i % 2 ? "#14b8a6" : "#e07a5f"} position={[f.x + 0.22, 1.42, f.z]} />
        ))}
      </Instances>
      {/* hurdles — striped bars on posts */}
      {/* hurdles — INSTANCED: striped bars (per-instance colour) + posts */}
      <Instances castShadow limit={GAUNTLET_HURDLES.length * 4} range={GAUNTLET_HURDLES.length * 4}>
        <boxGeometry />
        <meshStandardMaterial roughness={0.85} />
        {GAUNTLET_HURDLES.flatMap((p, i) => [0, 1, 2, 3].map((seg) => (
          <Instance key={`${i}-${seg}`} color={seg % 2 ? "#e8e2d4" : "#e07a5f"}
            position={[p.x, p.y - 0.12, p.z - p.hd + (seg + 0.5) * (p.hd / 2)]} scale={[p.hw * 2, 0.24, p.hd / 2]} />
        )))}
      </Instances>
      <Instances limit={GAUNTLET_HURDLES.length * 2} range={GAUNTLET_HURDLES.length * 2}>
        <boxGeometry />
        <meshStandardMaterial color="#7a5c34" roughness={0.9} />
        {GAUNTLET_HURDLES.flatMap((p, i) => [-p.hd + 0.3, p.hd - 0.3].map((dz, j) => (
          <Instance key={`${i}-${j}`} position={[p.x, (p.y - 0.2) / 2, p.z + dz]} scale={[0.18, p.y - 0.2, 0.18]} />
        )))}
      </Instances>
      {/* the ponds: layered water + reeds + lily pads, stones to hop */}
      {GAUNTLET_PONDS.map((pond, pi) => {
        const w = pond.x2 - pond.x1;
        const d = pond.z2 - pond.z1;
        const cx = (pond.x1 + pond.x2) / 2;
        const cz = (pond.z1 + pond.z2) / 2;
        return (
          <group key={`pond${pi}`}>
            <mesh position={[cx, 0.02, cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[w, d]} />
              <meshStandardMaterial color="#5aa8c8" roughness={0.4} />
            </mesh>
            <mesh position={[cx, 0.045, cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[w - 1.2, d - 1.2]} />
              <meshStandardMaterial color="#7ec3d8" roughness={0.25} transparent opacity={0.85} />
            </mesh>
            {/* living water: rings breathing outward */}
            {[0, 1, 2].map((i) => (
              <mesh
                key={`rp${i}`}
                ref={(el) => { ripples.current[pi * 3 + i] = el; }}
                position={[cx - w / 4 + (i * w) / 4, 0.06, cz + (i % 2 ? 1.4 : -1.2)]}
                rotation={[-Math.PI / 2, 0, 0]}
              >
                <ringGeometry args={[1.4, 1.65, 26]} />
                <meshStandardMaterial color="#dff2f8" transparent opacity={0.3} roughness={0.4} />
              </mesh>
            ))}
            {/* reeds render once, instanced, after the ponds (see InstancedReeds) */}
            {[0, 1, 2].map((i) => (
              <LilyPad key={`l${i}`} position={[pond.x1 + 1.6 + i * (w / 3), 0.06, cz + (i % 2 ? 1.6 : -1.8)]} flower={i === 1} />
            ))}
          </group>
        );
      })}
      {/* every pond's reeds, batched into 4 draw calls */}
      <InstancedReeds spots={reedSpots} />
      {/* hop-stone shells — INSTANCED (31 spheres → 1 draw call) */}
      <Instances limit={GAUNTLET_STONES.length} range={GAUNTLET_STONES.length}>
        <sphereGeometry args={[1, 8, 6]} />
        <meshStandardMaterial color="#cfc6b5" roughness={1} flatShading />
        {GAUNTLET_STONES.map((p, i) => {
          const sc = Math.min(p.hw, p.hd);
          return (
            <Instance key={i} position={[p.x, p.y - sc * 0.62, p.z]} rotation={[0, i * 1.3, 0]} scale={[sc * 1.18, sc * 0.62, sc * 1.18]} />
          );
        })}
      </Instances>
      {GAUNTLET_STONES.map((p, i) => (
        <Rock key={`rk${i}`} position={[p.x, p.y - 0.7, p.z]} scale={Math.min(p.hw, p.hd) * 1.0} rotation={i * 1.7} />
      ))}
      {/* rampart stairs — INSTANCED (block + edging) */}
      <Instances castShadow limit={GAUNTLET_STAIRS.length} range={GAUNTLET_STAIRS.length}>
        <boxGeometry />
        <meshStandardMaterial roughness={1} />
        {GAUNTLET_STAIRS.map((p, i) => (
          <Instance key={i} color={i % 3 === 1 ? "#8f8a7d" : "#9d968a"} position={[p.x, p.y / 2, p.z]} scale={[p.hw * 2, p.y, p.hd * 2]} />
        ))}
      </Instances>
      <Instances limit={GAUNTLET_STAIRS.length} range={GAUNTLET_STAIRS.length}>
        <boxGeometry />
        <meshStandardMaterial color="#7a756a" roughness={1} />
        {GAUNTLET_STAIRS.map((p, i) => (
          <Instance key={i} position={[p.x, p.y + 0.03, p.z]} scale={[p.hw * 2 + 0.12, 0.06, p.hd * 2 + 0.12]} />
        ))}
      </Instances>
      {/* slalom walls — INSTANCED (box + cap course) */}
      <Instances castShadow limit={GAUNTLET_WALLS.length} range={GAUNTLET_WALLS.length}>
        <boxGeometry />
        <meshStandardMaterial color="#8f8a7d" roughness={0.95} />
        {GAUNTLET_WALLS.map((p, i) => (
          <Instance key={i} position={[p.x, p.y / 2, p.z]} scale={[p.hw * 2, p.y, p.hd * 2]} />
        ))}
      </Instances>
      <Instances limit={GAUNTLET_WALLS.length} range={GAUNTLET_WALLS.length}>
        <boxGeometry />
        <meshStandardMaterial color="#7a756a" roughness={0.95} />
        {GAUNTLET_WALLS.map((p, i) => (
          <Instance key={i} position={[p.x, p.y + 0.06, p.z]} scale={[p.hw * 2 + 0.16, 0.12, p.hd * 2 + 0.16]} />
        ))}
      </Instances>
      {/* spinning sweepers — striped arms off a machined hub, warning ring on the deck */}
      {GAUNTLET_SWEEPERS.map((s, i) => (
        <group key={`sw${i}`} position={[s.cx, 0, s.cz]}>
          {/* warning ring painted on the ground under the swing */}
          <mesh position={[0, 0.045, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[s.r - 0.35, s.r + 0.35, 40]} />
            <meshStandardMaterial color="#e07a5f" transparent opacity={0.35} roughness={1} depthWrite={false} />
          </mesh>
          {/* machined hub: base plate, column, spinning cap */}
          <mesh position={[0, 0.09, 0]}>
            <cylinderGeometry args={[0.85, 0.95, 0.18, 14]} />
            <meshStandardMaterial color="#4a5058" roughness={0.6} metalness={0.3} />
          </mesh>
          <mesh position={[0, 0.55, 0]}>
            <cylinderGeometry args={[0.32, 0.42, 0.95, 12]} />
            <meshStandardMaterial color="#6b7280" roughness={0.5} metalness={0.4} />
          </mesh>
          <group ref={(el) => { arms.current[i] = el; }}>
            <mesh position={[0, 1.06, 0]}>
              <cylinderGeometry args={[0.4, 0.44, 0.14, 12]} />
              <meshStandardMaterial color="#3a3f47" roughness={0.5} metalness={0.4} />
            </mesh>
            {/* the arm: red/white hazard segments, tapering to the tip */}
            {[0, 1, 2, 3].map((seg) => (
              <mesh key={seg} position={[(seg + 0.5) * (s.r / 4), 0.75, 0]} castShadow>
                <boxGeometry args={[s.r / 4, 0.26 - seg * 0.03, 0.26 - seg * 0.03]} />
                <meshStandardMaterial color={seg % 2 ? "#e8e2d4" : "#e07a5f"} roughness={0.7} />
              </mesh>
            ))}
            {/* glowing striker tip */}
            <mesh position={[s.r, 0.75, 0]}>
              <sphereGeometry args={[0.34, 10, 10]} />
              <meshStandardMaterial color="#ff5a3c" emissive="#ff3c1e" emissiveIntensity={0.9} toneMapped={false} roughness={0.4} />
            </mesh>
            {/* the afterimage: three fading arc sectors trailing the arm, so its
                sweep direction and path read in one glance */}
            {[0, 1, 2].map((k) => {
              const gap = 0.14 + k * 0.26;
              const st = s.w > 0 ? gap : -gap - 0.26;
              return (
                <mesh key={`trail${k}`} position={[0, 0.75, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                  <ringGeometry args={[s.r - 0.55, s.r + 0.34, 12, 1, st, 0.26]} />
                  <meshBasicMaterial color="#ff5a3c" transparent opacity={0.15 - k * 0.045} depthWrite={false} side={THREE.DoubleSide} />
                </mesh>
              );
            })}
          </group>
        </group>
      ))}
      {/* THE STOMPERS — pistons over the lane on a fixed slam cycle. The head's
          height comes from stomperHeadY, the exact function the crush check
          reads: what flattens you is what you watched coming down. */}
      {GAUNTLET_STOMPERS.map((s, i) => (
        <group key={`stp${i}`} position={[s.x, 0, s.z]}>
          {/* gantry: two legs + a crossbeam the piston hangs from */}
          {[-2.3, 2.3].map((dz) => (
            <mesh key={dz} position={[0, 2.1, dz]} castShadow>
              <boxGeometry args={[0.28, 4.2, 0.28]} />
              <meshStandardMaterial color="#4a5058" metalness={0.3} roughness={0.6} />
            </mesh>
          ))}
          <mesh position={[0, 4.28, 0]}>
            <boxGeometry args={[0.34, 0.34, 5.2]} />
            <meshStandardMaterial color="#3a3f47" metalness={0.3} roughness={0.6} />
          </mesh>
          {/* the kill zone painted on the deck */}
          <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[1.1, 1.5, 24]} />
            <meshStandardMaterial color="#e0b23c" transparent opacity={0.4} roughness={1} depthWrite={false} />
          </mesh>
          {/* the piston head — driven per-frame off stomperHeadY */}
          <group ref={(el) => { stomperHeads.current[i] = el; }}>
            <mesh castShadow>
              <boxGeometry args={[2.0, 0.9, 2.0]} />
              <meshStandardMaterial color="#8a4a3a" metalness={0.2} roughness={0.7} />
            </mesh>
            <mesh position={[0, 0.65, 0]}>
              <cylinderGeometry args={[0.16, 0.16, 2.6, 8]} />
              <meshStandardMaterial color="#6b7280" metalness={0.5} roughness={0.4} />
            </mesh>
            {[-1.01, 1.01].map((dx) => (
              <mesh key={dx} position={[dx, 0, 0]}>
                <boxGeometry args={[0.02, 0.9, 2.0]} />
                <meshStandardMaterial color="#e0b23c" roughness={0.8} />
              </mesh>
            ))}
          </group>
        </group>
      ))}
      {/* checkpoint flags — hairpin flags on the apron rim, lane flags on the shoulder */}
      {GAUNTLET_CHECKPOINTS.slice(1).map((c, i) => {
        const dz = c.z - g.cz;
        const off = Math.abs(Math.abs(dz) - 8) < 0.5 ? (dz < 0 ? -7 : 7) : dz > 8 ? LANE_HALF + 0.6 : -(LANE_HALF + 0.6);
        return (
        <group key={`cp${i}`} position={[c.x, 0, c.z + off]}>
          <mesh position={[0, 1.1, 0]}>
            <cylinderGeometry args={[0.06, 0.08, 2.2, 8]} />
            <meshStandardMaterial color="#5b4632" roughness={0.9} />
          </mesh>
          <group ref={(el) => { cpFlags.current[i] = el; }} position={[0.4, 1.85, 0]}>
            {/* two-tone flag: teal field + deep-teal tail stripe */}
            <mesh>
              <planeGeometry args={[0.8, 0.5]} />
              <meshStandardMaterial color="#8ad6ce" side={THREE.DoubleSide} />
            </mesh>
            <mesh position={[0, -0.19, 0.002]}>
              <planeGeometry args={[0.8, 0.12]} />
              <meshStandardMaterial color="#0f766e" side={THREE.DoubleSide} />
            </mesh>
          </group>
        </group>
        );
      })}
      {/* the corridor hedges — INSTANCED: ~140 segments → 2 draw calls */}
      <Instances castShadow limit={GAUNTLET_SIDEWALLS.length} range={GAUNTLET_SIDEWALLS.length}>
        <boxGeometry />
        <meshStandardMaterial color="#3e7a48" roughness={1} />
        {GAUNTLET_SIDEWALLS.map((p, i) => (
          <Instance key={i} position={[p.x, p.y / 2, p.z]} scale={[p.hw * 2, p.y, p.hd * 2]} />
        ))}
      </Instances>
      <Instances limit={GAUNTLET_SIDEWALLS.length} range={GAUNTLET_SIDEWALLS.length}>
        <boxGeometry />
        <meshStandardMaterial color="#478a52" roughness={1} />
        {GAUNTLET_SIDEWALLS.map((p, i) => (
          <Instance key={i} position={[p.x, p.y + 0.18, p.z]} scale={[p.hw * 2.05, 0.4, p.hd * 2.4]} />
        ))}
      </Instances>
      {/* full-length grandstands — an F1 crowd walls BOTH sides of the course */}
      <GrandStand x={g.cx} z={g.cz - LANE_OFF - LANE_HALF - 7.4} facing={1} seed={1} />
      <GrandStand x={g.cx} z={g.cz + LANE_OFF + LANE_HALF + 7.4} facing={-1} seed={2} />
      {/* behind the stands: treelines, festival stalls, tents and balloons so
          the green void reads as event grounds, not empty lawn */}
      {[-1, 1].map((side) =>
        Array.from({ length: 5 }, (_, i) => (
          <Tree
            key={`bt${side}${i}`}
            position={[g.cx - 58 + i * 26, 0, g.cz + side * (LANE_OFF + LANE_HALF + 16.5 + (i % 3) * 2)]}
            scale={0.9 + (i % 4) * 0.14}
            variant={i % 5 === 2 ? 'blossom' : i % 3 === 0 ? 'pine' : 'round'}
          />
        )),
      )}
      {[-1, 1].map((side) => (
        <group key={`fest${side}`}>
          <MarketStall position={[g.cx - 20, 0, g.cz + side * (LANE_OFF + LANE_HALF + 14)]} rotation={side > 0 ? Math.PI : 0} awning={side > 0 ? "#2dd4bf" : "#e07a5f"} />
          {/* one tent + one balloon per side (was 4 + 6) */}
          <group position={[g.cx + 24, 0, g.cz + side * (LANE_OFF + LANE_HALF + 15.5)]}>
            <mesh position={[0, 1.15, 0]}>
              <coneGeometry args={[2.1, 2.3, 6]} />
              <meshStandardMaterial color={side > 0 ? '#5b6f9e' : '#c99a3a'} roughness={0.9} />
            </mesh>
          </group>
          <group position={[g.cx - 50, 0, g.cz + side * (LANE_OFF + LANE_HALF + 12.5)]}>
            {/* a tethered festival balloon — sheen on the skin, string to the ground */}
            <mesh position={[0, 5.6, 0]}>
              <sphereGeometry args={[0.55, 8, 8]} />
              <meshStandardMaterial color={side > 0 ? '#e07a5f' : '#2dd4bf'} emissive={side > 0 ? '#e07a5f' : '#2dd4bf'} emissiveIntensity={0.12} roughness={0.3} />
            </mesh>
            <mesh position={[0, 2.6, 0]}>
              <cylinderGeometry args={[0.008, 0.008, 5.2, 4]} />
              <meshStandardMaterial color="#d8d2be" roughness={1} />
            </mesh>
          </group>
        </group>
      ))}
      {/* extra grounds fill: groves, rocks and picnic clutter in the open green */}
      {Array.from({ length: 8 }, (_, i) => {
        const a2 = i * 2.399963 + 1.1;
        const rr = 32 + (i % 9) * 6.4;
        const gx = g.cx + Math.cos(a2) * rr;
        const gz = g.cz + Math.sin(a2) * rr;
        if (Math.abs(gz - g.cz) < LANE_OFF + LANE_HALF + 15) return null; // keep clear of lanes + stands
        return i % 3 === 0 ? (
          <Tree key={`gf${i}`} position={[gx, 0, gz]} scale={0.85 + (i % 4) * 0.15} variant={i % 5 === 1 ? "blossom" : "round"} />
        ) : i % 3 === 1 ? (
          <Rock key={`gf${i}`} position={[gx, 0, gz]} scale={0.7 + (i % 3) * 0.3} rotation={i} />
        ) : (
          <Bush key={`gf${i}`} position={[gx, 0, gz]} scale={0.9 + (i % 3) * 0.2} />
        );
      })}
      {[[-70, 1], [55, -1]].map(([dx, side], i) => (
        <group key={`pic${i}`} position={[g.cx + dx, 0, g.cz + side * (LANE_OFF + LANE_HALF + 19)]}>
          <HayBale position={[0, 0, 0]} scale={0.8} rotation={i * 1.2} />
          <Barrel position={[1.4, 0, 0.6]} rotation={0.7} />
          <Flowers position={[-1.2, 0.02, 0.8]} scale={1.1} />
        </group>
      ))}
      {/* trackside props */}
      <Barrel position={[g.cx - 80, 0, g.cz - LANE_OFF - LANE_HALF - 2.6]} />
      <Barrel position={[g.cx - 79, 0, g.cz - LANE_OFF - LANE_HALF - 3.4]} rotation={0.8} />
      <Cart position={[g.cx + 30, 0, g.cz + LANE_OFF + LANE_HALF + 3.4]} rotation={0.4} />
      <HayBale position={[g.cx + 64, 0, g.cz - LANE_OFF - LANE_HALF - 2.8]} scale={0.9} rotation={0.3} />
      <LampPost position={[g.cx - 40, 0, g.cz + LANE_OFF + LANE_HALF + 8.2]} />
      <LampPost position={[g.cx + 42, 0, g.cz - LANE_OFF - LANE_HALF - 8.2]} />
    </group>
  );
}

// A full-length F1-style grandstand: stepped rows under a canopy, packed with
// an INSTANCED crowd in Axon-avatar colors doing a rolling wave. One stand per
// side spans the whole course; the crowd is 4 draw calls total.
const CROWD_Z_AXIS = new THREE.Vector3(0, 0, 1);

function GrandStand({ x, z, facing, seed }: { x: number; z: number; facing: 1 | -1; seed: number }) {
  const LEN = 132;
  const ROWS = 5;
  const SEATS = 44;
  const N = ROWS * SEATS;
  const torso = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const arms = useRef<THREE.InstancedMesh>(null);
  const legs = useRef<THREE.InstancedMesh>(null);
  const hair = useRef<THREE.InstancedMesh>(null);
  const m4 = useRef(new THREE.Matrix4());
  const q0 = useRef(new THREE.Quaternion());
  const qA = useRef(new THREE.Quaternion());
  const v3 = useRef(new THREE.Vector3());
  const s3 = useRef(new THREE.Vector3(1, 1, 1));

  // seat grid + per-person colors, once
  const seatData = useMemo(() => {
    const SHIRT = ["#e07a5f", "#5b6f9e", "#4a7c59", "#c99a3a", "#8a5a86", "#3f8f8a", "#c0563e", "#2dd4bf"];
    const SKIN = ["#e8b88a", "#c98d5f", "#8a5a3a", "#f2caa0"];
    const HAIR = ["#2a2118", "#5b3a22", "#8a6a2a", "#c9a878", "#3a3a45", "#7a2e2a"];
    const seats: { sx: number; sy: number; sz: number; shirt: THREE.Color; skin: THREE.Color; hairC: THREE.Color; ph: number }[] = [];
    for (let row = 0; row < ROWS; row++) {
      for (let i = 0; i < SEATS; i++) {
        const j = row * SEATS + i;
        seats.push({
          sx: -LEN / 2 + 1.5 + i * ((LEN - 3) / (SEATS - 1)) + (row % 2) * 0.7,
          sy: 0.95 + row * 0.72,
          sz: row * 1.05,
          shirt: new THREE.Color(SHIRT[(j * 7 + seed) % SHIRT.length]),
          skin: new THREE.Color(SKIN[(j * 5 + seed * 3) % SKIN.length]),
          hairC: new THREE.Color(HAIR[(j * 11 + seed * 5) % HAIR.length]),
          ph: j * 0.001,
        });
      }
    }
    return seats;
  }, [seed]);

  useEffect(() => {
    // per-instance colors (static)
    const t = torso.current, h = head.current, a = arms.current, l = legs.current, hr = hair.current;
    if (!t || !h || !a || !l || !hr) return;
    seatData.forEach((s, i) => {
      t.setColorAt(i, s.shirt);
      h.setColorAt(i, s.skin);
      a.setColorAt(i, s.skin);
      hr.setColorAt(i, s.hairC);
    });
    // seated legs read as trousers — one muted tone
    const trouser = new THREE.Color("#4a4a55");
    seatData.forEach((_, i) => l.setColorAt(i, trouser));
    if (t.instanceColor) t.instanceColor.needsUpdate = true;
    if (h.instanceColor) h.instanceColor.needsUpdate = true;
    if (a.instanceColor) a.instanceColor.needsUpdate = true;
    if (l.instanceColor) l.instanceColor.needsUpdate = true;
    if (hr.instanceColor) hr.instanceColor.needsUpdate = true;
  }, [seatData]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const tm = torso.current, hm = head.current, am = arms.current, lm = legs.current, hrm = hair.current;
    if (!tm || !hm || !am || !lm || !hrm) return;
    q0.current.identity();
    for (let i = 0; i < N; i++) {
      const s = seatData[i];
      // the wave rolls down the stand; everyone else idles with a tiny sway
      const wave = Math.max(0, Math.sin(t * 2.1 - s.sx * 0.09 + seed * 2));
      const hop = wave * wave * 0.42 + Math.sin(t * 3 + i) * 0.01;
      v3.current.set(s.sx, s.sy + hop + 0.3, s.sz);
      m4.current.compose(v3.current, q0.current, s3.current.set(1, 1, 1));
      tm.setMatrixAt(i, m4.current);
      v3.current.set(s.sx, s.sy + hop + 0.78, s.sz);
      m4.current.compose(v3.current, q0.current, s3.current.set(1, 1, 1));
      hm.setMatrixAt(i, m4.current);
      // arms RAISE with the wave — rotated up, never scaled (a scaled box reads as a square)
      const lift = wave * wave;
      qA.current.setFromAxisAngle(CROWD_Z_AXIS, lift * 1.25);
      v3.current.set(s.sx, s.sy + hop + 0.58 + lift * 0.34, s.sz + 0.06);
      m4.current.compose(v3.current, qA.current, s3.current.set(1, 1, 1));
      am.setMatrixAt(i, m4.current);
      // seated legs hang over the terrace lip; hair rides the head
      v3.current.set(s.sx, s.sy + hop - 0.02, s.sz - 0.28);
      m4.current.compose(v3.current, q0.current, s3.current.set(1, 1, 1));
      lm.setMatrixAt(i, m4.current);
      // hair: a cap that fully WRAPS the head crown — no coplanar faces, no shimmer
      v3.current.set(s.sx, s.sy + hop + 0.97, s.sz);
      m4.current.compose(v3.current, q0.current, s3.current.set(1, 1, 1));
      hrm.setMatrixAt(i, m4.current);
    }
    tm.instanceMatrix.needsUpdate = true;
    hm.instanceMatrix.needsUpdate = true;
    am.instanceMatrix.needsUpdate = true;
    lm.instanceMatrix.needsUpdate = true;
    hrm.instanceMatrix.needsUpdate = true;
  });

  return (
    <group position={[x, 0, z]} rotation={[0, facing === 1 ? Math.PI : 0, 0]}>
      {/* stepped terraces */}
      {[0, 1, 2, 3, 4].map((row) => (
        <mesh key={row} position={[0, 0.34 + row * 0.72, row * 1.05]}>
          <boxGeometry args={[LEN, 0.68 + row * 0.0, 1.05]} />
          <meshStandardMaterial color={row % 2 ? "#8a6a44" : "#97764e"} roughness={0.95} />
        </mesh>
      ))}
      {/* open-air stands — just a low back wall, no roof blocking the view */}
      <mesh position={[0, 2.2, ROWS * 1.05 - 0.3]}>
        <boxGeometry args={[LEN, 1.6, 0.3]} />
        <meshStandardMaterial color="#6b4a2a" roughness={1} />
      </mesh>
      {/* pennant poles along the back wall */}
      {Array.from({ length: 7 }, (_, i) => -LEN / 2 + 6 + i * ((LEN - 12) / 6)).map((dx, i) => (
        <group key={dx} position={[dx, 0, ROWS * 1.05 - 0.3]}>
          <mesh position={[0, 3.4, 0]}>
            <cylinderGeometry args={[0.06, 0.08, 3.2, 6]} />
            <meshStandardMaterial color="#5b4632" roughness={0.9} />
          </mesh>
          <mesh position={[0.35, 4.7, 0]}>
            <planeGeometry args={[0.7, 0.45]} />
            <meshStandardMaterial color={i % 2 ? "#2dd4bf" : "#e07a5f"} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
      {/* the crowd — instanced, 3 draw calls */}
      <instancedMesh ref={torso} args={[undefined, undefined, N]} frustumCulled={false}>
        <boxGeometry args={[0.5, 0.56, 0.32]} />
        <meshStandardMaterial roughness={1} />
      </instancedMesh>
      <instancedMesh ref={head} args={[undefined, undefined, N]} frustumCulled={false}>
        <boxGeometry args={[0.3, 0.3, 0.28]} />
        <meshStandardMaterial roughness={1} />
      </instancedMesh>
      <instancedMesh ref={arms} args={[undefined, undefined, N]} frustumCulled={false}>
        <boxGeometry args={[0.74, 0.16, 0.16]} />
        <meshStandardMaterial roughness={1} />
      </instancedMesh>
      {/* seated legs + hair caps — the same blocky look as the world's avatars */}
      <instancedMesh ref={legs} args={[undefined, undefined, N]} frustumCulled={false}>
        <boxGeometry args={[0.44, 0.5, 0.24]} />
        <meshStandardMaterial roughness={1} />
      </instancedMesh>
      <instancedMesh ref={hair} args={[undefined, undefined, N]} frustumCulled={false}>
        <boxGeometry args={[0.38, 0.2, 0.36]} />
        <meshStandardMaterial roughness={1} />
      </instancedMesh>
    </group>
  );
}

// A long-dead tree — bare trunk and clawing branches, pure silhouette dressing.
function DeadTree({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 1.6, 0]}>
        <cylinderGeometry args={[0.14, 0.32, 3.2, 7]} />
        <meshStandardMaterial color="#3a332c" roughness={1} />
      </mesh>
      {[
        [0.45, 2.7, 0.4, 0.9],
        [-0.5, 3.0, -0.3, -1.0],
        [0.15, 3.55, -0.4, 0.5],
        [-0.3, 2.2, 0.45, -0.6],
      ].map(([dx, y, dz, tilt], i) => (
        <mesh key={i} position={[dx, y, dz]} rotation={[dz * 0.8, 0, tilt]}>
          <cylinderGeometry args={[0.025, 0.09, 1.7, 5]} />
          <meshStandardMaterial color="#332d26" roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

// A dark figure swaying just past the fence line — the horde you can't reach.
function ZombieSilhouette({ seed }: { seed: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame((st) => {
    if (g.current) g.current.rotation.z = Math.sin(st.clock.elapsedTime * 0.7 + seed) * 0.05;
  });
  const dark = "#151b15";
  return (
    <group ref={g}>
      <mesh position={[0, 0.8, 0]}><boxGeometry args={[0.5, 1.6, 0.3]} /><meshStandardMaterial color={dark} roughness={1} /></mesh>
      <mesh position={[0, 1.82, 0]} rotation={[0.15, 0, 0.1]}><boxGeometry args={[0.36, 0.38, 0.3]} /><meshStandardMaterial color={dark} roughness={1} /></mesh>
      {[-0.35, 0.35].map((dx) => (
        <mesh key={dx} position={[dx, 1.3, 0.28]} rotation={[-1.2, 0, 0]}><boxGeometry args={[0.13, 0.7, 0.13]} /><meshStandardMaterial color={dark} roughness={1} /></mesh>
      ))}
    </group>
  );
}

// Low fog pads drifting slowly between the graves.
function GroundFog({ cx, cz }: { cx: number; cz: number }) {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const pads = useMemo(
    () => Array.from({ length: 3 }, (_, i) => ({ a: i * 2.1, r: 9 + (i % 2) * 8, s: 6 + (i % 2) * 3, sp: 0.05 + (i % 2) * 0.04 })),
    [],
  );
  useFrame((st) => {
    const t = st.clock.elapsedTime;
    refs.current.forEach((m, i) => {
      if (!m) return;
      const pad = pads[i];
      m.position.set(cx + Math.cos(pad.a + t * pad.sp) * pad.r, 0.3 + Math.sin(t * 0.3 + i) * 0.06, cz + Math.sin(pad.a + t * pad.sp) * pad.r);
    });
  });
  return (
    <group>
      {pads.map((pad, i) => (
        <mesh key={i} ref={(el) => { refs.current[i] = el; }} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[pad.s, 18]} />
          <meshBasicMaterial color="#aab5a5" transparent opacity={0.1} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

// ── Zombie Waves arena ────────────────────────────────────────────────────────
export function ZombieArena() {
  const f = ARENAS.arena;
  const torches = useRef<(THREE.PointLight | null)[]>([]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    torches.current.forEach((li, i) => {
      if (li) li.intensity = 3.4 + Math.sin(t * 9 + i * 2.4) * 0.9 + Math.sin(t * 23 + i) * 0.4;
    });
  });
  // tombstones = the thin blockers; crates = the low ones; walls = long ones.
  // The crypt and obelisk plats get dedicated renders — exclude them here.
  const isCrypt = (p: (typeof ZOMBIE_PLATS)[number]) => p.x === ZOMBIE_CRYPT.x && p.z === ZOMBIE_CRYPT.z;
  const isObelisk = (p: (typeof ZOMBIE_PLATS)[number]) => p.x === ZOMBIE_OBELISK.x && p.z === ZOMBIE_OBELISK.z;
  // the shed has DEDICATED visuals — its colliders must not double-render as
  // ruins/crates on top of them (that overlap was a visible z-fight shimmer)
  const nearShed = (p: (typeof ZOMBIE_PLATS)[number]) => Math.abs(p.x - ZOMBIE_SHED.x) < 4.5 && Math.abs(p.z - ZOMBIE_SHED.z) < 4.5;
  const graves = ZOMBIE_PLATS.filter((p) => p.hd <= 0.25);
  const crates = ZOMBIE_PLATS.filter((p) => p.y === 1.0 && !nearShed(p));
  const walls = ZOMBIE_PLATS.filter((p) => p.y === 1.9 && (p.hw > 2 || p.hd > 2) && p.hw < 5 && !isCrypt(p) && !isObelisk(p) && !nearShed(p));
  const barn = ZOMBIE_PLATS.find((p) => p.hw > 5)!;
  return (
    <group>
      <ArenaValley arena={f} charmClear={34} mood="grim" avoid={(x, z) => (Math.abs(x - f.cx) < 30 && Math.abs(z - f.cz) < 22) || Math.hypot(x - (f.cx + 30), z - (f.cz + 22)) < 9 || Math.hypot(x - (f.cx - 34), z - (f.cz - 30)) < 10} />
      {/* thick, low graveyard fog — with the night sky it closes the world in */}
      <ArenaFog color="#10150f" near={20} far={140} />
      {/* WALL-BUYS: a known gun at a known price, chalked on the wall */}
      {ZOMBIE_WALLBUYS.map((b) => (
        <group key={b.weapon} position={[b.x, 0, b.z]} rotation={[0, b.ry, 0]}>
          {/* chalk outline board */}
          <mesh position={[0, 1.5, -0.06]}>
            <planeGeometry args={[1.9, 0.9]} />
            <meshStandardMaterial color="#20241e" roughness={1} />
          </mesh>
          <mesh position={[0, 1.5, -0.05]}>
            <planeGeometry args={[1.78, 0.78]} />
            <meshBasicMaterial color="#0f120e" />
          </mesh>
          {/* the gun itself, mounted flat */}
          <group position={[0, 1.5, 0.05]} rotation={[0, Math.PI / 2, 0]} scale={1.15}>
            <WeaponModel id={b.weapon} />
          </group>
          <Label text={`${WEAPONS[b.weapon].name.toUpperCase()} — ${b.cost}`} position={[0, 2.35, 0.1]} color="#e8e2d4" scale={1.7} />
        </group>
      ))}
      {/* THE PERK MACHINE: one shrine-like cabinet — +50 max HP, once per run */}
      <group position={[ZOMBIE_PERK.x, 0, ZOMBIE_PERK.z]} rotation={[0, -0.5, 0]}>
        <mesh position={[0, 0.9, 0]} castShadow>
          <boxGeometry args={[0.9, 1.8, 0.7]} />
          <meshStandardMaterial color="#5b1f24" roughness={0.6} metalness={0.15} />
        </mesh>
        <mesh position={[0, 1.25, 0.36]}>
          <planeGeometry args={[0.6, 0.7]} />
          <meshStandardMaterial color="#ff7b88" emissive="#e0475a" emissiveIntensity={0.9} toneMapped={false} />
        </mesh>
        <mesh position={[0, 1.86, 0]}>
          <boxGeometry args={[0.96, 0.14, 0.76]} />
          <meshStandardMaterial color="#3a1418" roughness={0.7} />
        </mesh>
        <pointLight position={[0, 1.4, 0.7]} color="#ff6b7d" intensity={1.6} distance={6} />
        <Label text={`VIGOR — ${ZOMBIE_PERK.cost}`} position={[0, 2.5, 0]} color="#ff8d9a" scale={1.8} />
      </group>
      {/* QUICK HANDS — the reload perk machine by the shed */}
      <group position={[ZOMBIE_PERK2.x, 0, ZOMBIE_PERK2.z]} rotation={[0, 0.6, 0]}>
        <mesh position={[0, 0.9, 0]} castShadow>
          <boxGeometry args={[0.9, 1.8, 0.7]} />
          <meshStandardMaterial color="#12403c" roughness={0.6} metalness={0.15} />
        </mesh>
        <mesh position={[0, 1.25, 0.36]}>
          <planeGeometry args={[0.6, 0.7]} />
          <meshStandardMaterial color="#5eead4" emissive="#14b8a6" emissiveIntensity={0.9} toneMapped={false} />
        </mesh>
        <mesh position={[0, 1.86, 0]}>
          <boxGeometry args={[0.96, 0.14, 0.76]} />
          <meshStandardMaterial color="#0c2b28" roughness={0.7} />
        </mesh>
        <pointLight position={[0, 1.4, 0.7]} color="#2dd4bf" intensity={1.6} distance={6} />
        <Label text={`QUICK HANDS — ${ZOMBIE_PERK2.cost}`} position={[0, 2.5, 0]} color="#7ef2e4" scale={1.8} />
      </group>
      {/* grave-field grounds: two darker rectangles flanking the central path */}
      {[-1, 1].map((side) => (
        <mesh key={`field${side}`} position={[f.cx + side * 15.5, 0.004, f.cz - 7.5]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[17, 22]} />
          <meshStandardMaterial color="#7d8f68" roughness={1} />
        </mesh>
      ))}
      {/* the central path: spawn → obelisk plaza → crypt door */}
      <mesh position={[f.cx, 0.006, f.cz + 1]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[3.2, 26]} />
        <meshStandardMaterial color="#9a8a6a" roughness={1} />
      </mesh>
      <mesh position={[f.cx, 0.007, f.cz + 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[4.6, 24]} />
        <meshStandardMaterial color="#a99a78" roughness={1} />
      </mesh>
      {/* THE CRYPT — a stone mausoleum you fight around (its plat collides) */}
      <group position={[ZOMBIE_CRYPT.x, 0, ZOMBIE_CRYPT.z]}>
        <mesh position={[0, 1.25, 0]}>
          <boxGeometry args={[6.8, 2.5, 5.2]} />
          <meshStandardMaterial color="#8f8a7d" roughness={1} />
        </mesh>
        {/* cornice + gabled roof slabs */}
        <mesh position={[0, 2.62, 0]}>
          <boxGeometry args={[7.2, 0.24, 5.6]} />
          <meshStandardMaterial color="#7a756a" roughness={1} />
        </mesh>
        {[-1, 1].map((sr) => (
          <mesh key={sr} position={[0, 3.2, sr * 1.35]} rotation={[sr * 0.5, 0, 0]}>
            <boxGeometry args={[7.4, 0.18, 3.1]} />
            <meshStandardMaterial color="#6e6a60" roughness={1} />
          </mesh>
        ))}
        {/* door arch on the south face + iron gate */}
        <mesh position={[0, 1.0, 2.62]}>
          <boxGeometry args={[1.7, 2.0, 0.14]} />
          <meshStandardMaterial color="#3a3630" roughness={1} />
        </mesh>
        {[-0.4, 0, 0.4].map((dx) => (
          <mesh key={dx} position={[dx, 1.0, 2.7]}>
            <boxGeometry args={[0.07, 1.9, 0.05]} />
            <meshStandardMaterial color="#2a2d33" metalness={0.3} roughness={0.7} />
          </mesh>
        ))}
        {/* stone block courses + window slits */}
        {[0.7, 1.4].map((yy) => (
          <mesh key={`co${yy}`} position={[0, yy, 0]}>
            <boxGeometry args={[6.84, 0.04, 5.24]} />
            <meshStandardMaterial color="#7a756a" roughness={1} />
          </mesh>
        ))}
        {[-1, 1].map((sx) => (
          <mesh key={`wi${sx}`} position={[sx * 3.42, 1.5, 0]}>
            <boxGeometry args={[0.06, 0.7, 0.28]} />
            <meshStandardMaterial color="#1a1a14" roughness={1} />
          </mesh>
        ))}
        {/* pilasters + a cross on the gable */}
        {[-3.1, 3.1].map((dx) => (
          <mesh key={dx} position={[dx, 1.25, 2.5]}>
            <boxGeometry args={[0.5, 2.5, 0.5]} />
            <meshStandardMaterial color="#847f72" roughness={1} />
          </mesh>
        ))}
        <group position={[0, 4.1, 0]}>
          <mesh><boxGeometry args={[0.12, 0.9, 0.12]} /><meshStandardMaterial color="#6e6a60" roughness={1} /></mesh>
          <mesh position={[0, 0.16, 0]}><boxGeometry args={[0.5, 0.12, 0.12]} /><meshStandardMaterial color="#6e6a60" roughness={1} /></mesh>
        </group>
        {/* entry steps + flanking urns */}
        <mesh position={[0, 0.1, 3.0]}>
          <boxGeometry args={[2.6, 0.2, 0.9]} />
          <meshStandardMaterial color="#7a756a" roughness={1} />
        </mesh>
        <mesh position={[0, 0.26, 2.75]}>
          <boxGeometry args={[2.2, 0.14, 0.5]} />
          <meshStandardMaterial color="#847f72" roughness={1} />
        </mesh>
        {[-2.4, 2.4].map((dx) => (
          <group key={dx} position={[dx, 0, 3.1]}>
            <mesh position={[0, 0.28, 0]}>
              <cylinderGeometry args={[0.22, 0.3, 0.56, 10]} />
              <meshStandardMaterial color="#8f8a7d" roughness={1} />
            </mesh>
            <mesh position={[0, 0.62, 0]}>
              <sphereGeometry args={[0.24, 10, 8]} />
              <meshStandardMaterial color="#847f72" roughness={1} />
            </mesh>
          </group>
        ))}
        <pointLight position={[0, 1.6, 3.4]} color="#9adb76" intensity={2.5} distance={8} />
      </group>
      {/* THE OBELISK — the memorial on the plaza (its plinth collides) */}
      <group position={[ZOMBIE_OBELISK.x, 0, ZOMBIE_OBELISK.z]}>
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[1.8, 1.0, 1.8]} />
          <meshStandardMaterial color="#847f72" roughness={1} />
        </mesh>
        <mesh position={[0, 1.15, 0]}>
          <boxGeometry args={[1.3, 0.3, 1.3]} />
          <meshStandardMaterial color="#8f8a7d" roughness={1} />
        </mesh>
        <mesh position={[0, 2.9, 0]}>
          <cylinderGeometry args={[0.16, 0.55, 3.4, 4]} />
          <meshStandardMaterial color="#9aa0a2" roughness={0.95} flatShading />
        </mesh>
        <mesh position={[0, 4.75, 0]} rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[0.24, 0.5, 4]} />
          <meshStandardMaterial color="#b8b3a6" roughness={0.9} />
        </mesh>
      </group>
      {/* tombstones — INSTANCED slab + dirt mound (2 draw calls); the rounded
          crown keeps its compound tilt per-grave */}
      <Instances castShadow limit={graves.length} range={graves.length}>
        <boxGeometry />
        <meshStandardMaterial roughness={1} />
        {graves.map((p, i) => {
          const stone = ["#9aa0a2", "#8d9496", "#a4a9a8"][i % 3];
          const yaw = (i % 5) * 0.12 - 0.25, roll = (i % 3) * 0.04 - 0.04;
          return (
            <Instance key={i} color={stone} position={[p.x, p.y / 2 - 0.05, p.z]} rotation={[0, yaw, roll]} scale={[p.hw * 2, p.y - 0.3, p.hd * 2]} />
          );
        })}
      </Instances>
      <Instances limit={graves.length} range={graves.length}>
        <sphereGeometry args={[1, 8, 6]} />
        <meshStandardMaterial color="#6b5744" roughness={1} flatShading />
        {graves.map((p, i) => {
          const yaw = (i % 5) * 0.12 - 0.25, roll = (i % 3) * 0.04 - 0.04, d = p.hd + 0.85;
          return (
            <Instance key={i} position={[p.x + Math.sin(yaw) * d, 0.07, p.z + Math.cos(yaw) * d]} rotation={[0, yaw, roll]} scale={[p.hw * 1.5, 0.14, 0.8]} />
          );
        })}
      </Instances>
      {graves.map((p, i) => {
        const stone = ["#9aa0a2", "#8d9496", "#a4a9a8"][i % 3];
        return (
          <group key={`gc${i}`} position={[p.x, 0, p.z]} rotation={[0, (i % 5) * 0.12 - 0.25, (i % 3) * 0.04 - 0.04]}>
            <mesh position={[0, p.y - 0.21, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[p.hw, p.hw, p.hd * 2, 12, 1, false, 0, Math.PI]} />
              <meshStandardMaterial color={stone} roughness={1} />
            </mesh>
          </group>
        );
      })}
      {/* ruined walls — INSTANCED (main + crumble cap → 2 draw calls) */}
      <Instances limit={walls.length} range={walls.length}>
        <boxGeometry />
        <meshStandardMaterial color="#8f8a7d" roughness={1} />
        {walls.map((p, i) => (
          <Instance key={i} position={[p.x, p.y / 2, p.z]} scale={[p.hw * 2, p.y, p.hd * 2]} />
        ))}
      </Instances>
      <Instances limit={walls.length} range={walls.length}>
        <boxGeometry />
        <meshStandardMaterial color="#847f72" roughness={1} />
        {walls.map((p, i) => (
          <Instance key={i} position={[p.x + p.hw * 0.4, p.y + 0.2, p.z]} rotation={[0.1, 0.4, 0.12]} scale={[0.7, 0.4, Math.min(1, p.hd * 2)]} />
        ))}
      </Instances>
      {/* crates — INSTANCED box (thin top plank kept per-crate) */}
      <Instances limit={crates.length} range={crates.length}>
        <boxGeometry />
        <meshStandardMaterial color="#a9805a" roughness={0.9} />
        {crates.map((p, i) => (
          <Instance key={i} position={[p.x, p.y / 2, p.z]} rotation={[0, i * 0.6, 0]} scale={[p.hw * 2, p.y, p.hd * 2]} />
        ))}
      </Instances>
      {crates.map((p, i) => (
        <mesh key={`ct${i}`} position={[p.x, p.y + 0.006, p.z]} rotation={[-Math.PI / 2, i * 0.6, 0]}>
          <planeGeometry args={[p.hw * 2, p.hd * 2]} />
          <meshStandardMaterial color="#8a6a44" roughness={1} />
        </mesh>
      ))}
      {/* the derelict barn */}
      <Barn position={[barn.x, 0, barn.z]} rotation={0.35} />
      {/* the ruined chapel — walls collide (see layout), doorway open south */}
      <group position={[ZOMBIE_CHAPEL.x, 0, ZOMBIE_CHAPEL.z]}>
        {/* broken gable + rafters over the walls */}
        <mesh position={[0, 2.35, -2.8]} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[1.4, 1.4, 0.5]} />
          <meshStandardMaterial color="#8f8a7d" roughness={1} />
        </mesh>
        {[-2.4, 0, 2.4].map((dz) => (
          <mesh key={dz} position={[0, 2.5, dz]} rotation={[0, 0, 0.06]}>
            <boxGeometry args={[7.4, 0.16, 0.16]} />
            <meshStandardMaterial color="#5b4632" roughness={1} />
          </mesh>
        ))}
        {/* a cross on the gable */}
        <group position={[0, 3.4, -2.8]}>
          <mesh><boxGeometry args={[0.1, 0.7, 0.1]} /><meshStandardMaterial color="#5b4632" roughness={1} /></mesh>
          <mesh position={[0, 0.12, 0]}><boxGeometry args={[0.4, 0.1, 0.1]} /><meshStandardMaterial color="#5b4632" roughness={1} /></mesh>
        </group>
        {/* candle glow inside */}
        <pointLight position={[0, 1.2, 0]} color="#ffb35e" intensity={3} distance={7} />
      </group>
      {/* the SHED — walk in through the south door (walls collide via plats) */}
      <group position={[ZOMBIE_SHED.x, 0, ZOMBIE_SHED.z]}>
        {/* plank walls (visuals matching the three wall plats) */}
        <mesh position={[-2.6, 0.95, 0]}>
          <boxGeometry args={[0.7, 1.9, 4.4]} />
          <meshStandardMaterial color="#6b5138" roughness={1} />
        </mesh>
        <mesh position={[2.6, 0.95, 0]}>
          <boxGeometry args={[0.7, 1.9, 4.4]} />
          <meshStandardMaterial color="#6b5138" roughness={1} />
        </mesh>
        <mesh position={[0, 0.95, -2.0]}>
          <boxGeometry args={[5.6, 1.9, 0.7]} />
          <meshStandardMaterial color="#5f4831" roughness={1} />
        </mesh>
        {/* slanted tin roof + door frame */}
        <mesh position={[0, 2.2, -0.2]} rotation={[0.16, 0, 0]}>
          <boxGeometry args={[6.2, 0.12, 5.4]} />
          <meshStandardMaterial color="#555b60" metalness={0.35} roughness={0.6} />
        </mesh>
        {[-1.1, 1.1].map((dx) => (
          <mesh key={dx} position={[dx, 1.0, 2.2]}>
            <boxGeometry args={[0.16, 2.0, 0.16]} />
            <meshStandardMaterial color="#4a3b2a" roughness={1} />
          </mesh>
        ))}
        {/* inside: the workbench (its plat collides) + a hanging lantern */}
        <mesh position={[-1.2, 0.95, -0.9]}>
          <boxGeometry args={[1.8, 0.12, 1.0]} />
          <meshStandardMaterial color="#7a5c34" roughness={1} />
        </mesh>
        {[-1.9, -0.5].map((dx) => (
          <mesh key={`bl${dx}`} position={[dx, 0.45, -0.9]}>
            <boxGeometry args={[0.14, 0.9, 0.14]} />
            <meshStandardMaterial color="#5f4831" roughness={1} />
          </mesh>
        ))}
        <pointLight position={[0, 1.7, 0]} color="#ffb35e" intensity={2.2} distance={5} />
      </group>
      {/* ── atmosphere: bare trees, drifting ground fog, shapes beyond the fence */}
      <DeadTree position={[f.cx + 24, 0, f.cz - 18]} scale={1.1} />
      <DeadTree position={[f.cx - 16, 0, f.cz + 24]} scale={0.9} />
      <DeadTree position={[f.cx - 30, 0, f.cz + 8]} scale={1.25} />
      <GroundFog cx={f.cx} cz={f.cz} />
      {[0.9, 3.4, 5.4].map((a, i) => (
        <group key={`sil${i}`} position={[f.cx + Math.cos(a) * 44, 0, f.cz + Math.sin(a) * 44]} rotation={[0, -a + Math.PI / 2, 0]}>
          <ZombieSilhouette seed={i * 2.3} />
        </group>
      ))}
      {/* lantern posts along the graveyard paths */}
      <LampPost position={[f.cx - 10, 0, f.cz + 10]} />
      <LampPost position={[f.cx + 12, 0, f.cz - 14]} />
      <LampPost position={[f.cx + 22, 0, f.cz + 16]} />
      {/* a worn dirt path from spawn to the chapel */}
      <mesh position={[f.cx + 15, 0.006, f.cz + 13]} rotation={[-Math.PI / 2, 0.62, 0]}>
        <planeGeometry args={[34, 2.6]} />
        <meshStandardMaterial color="#9a8a6a" roughness={1} transparent opacity={0.85} />
      </mesh>
      {/* wrought-iron fence around the graveyard (gaps for the paths) — INSTANCED:
          every post + rail across the whole ring in 1 draw call (was ~65 meshes). */}
      {(() => {
        const posts: { x: number; z: number; ry: number }[] = [];
        const rails: { x: number; z: number; ry: number; dy: number }[] = [];
        for (let i = 0; i < 14; i++) {
          if (i % 5 === 2) continue; // gate gaps
          const a = (i / 14) * Math.PI * 2;
          const fx = f.cx + Math.cos(a) * 26.5;
          const fz = f.cz + Math.sin(a) * 26.5;
          const ry = -a + Math.PI / 2;
          for (const dx of [-4.4, 0, 4.4]) {
            posts.push({ x: fx + dx * Math.cos(ry), z: fz - dx * Math.sin(ry), ry });
          }
          for (const dy of [0.5, 1.15]) rails.push({ x: fx, z: fz, ry, dy });
        }
        return (
          <Instances limit={posts.length + rails.length} range={posts.length + rails.length}>
            <boxGeometry />
            <meshStandardMaterial color="#2a2d33" roughness={0.7} metalness={0.3} />
            {posts.map((p, i) => (
              <Instance key={`p${i}`} position={[p.x, 0.75, p.z]} rotation={[0, p.ry, 0]} scale={[0.12, 1.5, 0.12]} />
            ))}
            {rails.map((r, i) => (
              <Instance key={`r${i}`} position={[r.x, r.dy, r.z]} rotation={[0, r.ry, 0]} scale={[9.2, 0.07, 0.07]} />
            ))}
          </Instances>
        );
      })()}
      {/* torches — flickering firelight over the graves */}
      {[
        [f.cx - 14, f.cz + 4],
        [f.cx + 8, f.cz - 18],
        [f.cx + 18, f.cz + 10],
      ].map(([tx, tz], i) => (
        <group key={`tor${i}`} position={[tx, 0, tz]}>
          <mesh position={[0, 1.1, 0]}>
            <cylinderGeometry args={[0.07, 0.1, 2.2, 8]} />
            <meshStandardMaterial color="#4a3b2a" roughness={1} />
          </mesh>
          <mesh position={[0, 2.32, 0]}>
            <coneGeometry args={[0.22, 0.5, 8]} />
            <meshStandardMaterial color="#ffb35e" emissive="#ff8c2e" emissiveIntensity={1.8} toneMapped={false} />
          </mesh>
          <pointLight ref={(el) => { torches.current[i] = el; }} position={[0, 2.5, 0]} color="#ffab52" intensity={3.4} distance={13} />
        </group>
      ))}
      {/* scattered bones */}
      {Array.from({ length: 10 }, (_, i) => {
        const a = i * 2.399963 + 0.7;
        const r = 8 + (i % 5) * 4;
        return (
          <mesh
            key={`bn${i}`}
            position={[f.cx + Math.cos(a) * r, 0.06, f.cz + Math.sin(a) * r]}
            rotation={[0, a * 3, i % 2 ? 0.1 : -0.08]}
          >
            <capsuleGeometry args={[0.05, 0.5, 3, 6]} />
            <meshStandardMaterial color="#e5e0d3" roughness={1} />
          </mesh>
        );
      })}

      {/* dead trees + wrecks around the graveyard */}
      <Tree position={[f.cx + 16, 0, f.cz + 15]} variant="autumn" scale={1.15} />
      <Tree position={[f.cx - 24, 0, f.cz + 4]} variant="autumn" scale={0.95} />
      <Cart position={[f.cx + 28, 0, f.cz + 6]} rotation={2.4} />
      <Barrel position={[f.cx - 8, 0, f.cz - 20]} rotation={0.5} />
      <Barrel position={[f.cx - 9.2, 0, f.cz - 19.2]} />
    </group>
  );
}

// ── Run tracking for the time modes ───────────────────────────────────────────
export function ArcadeRunManager({
  mode,
  start,
  goal,
  poseRef,
  onStart,
  onFinish,
  resetPad,
  onAbort,
  onFell,
  onGhostSamples,
}: {
  mode: string;
  start: RunBox;
  goal: RunBox;
  poseRef: { current: { x: number; z: number; h?: number } };
  onStart: (mode: string, at: number) => void;
  onFinish: (mode: string, ms: number) => void;
  /** Optional ground pad that wipes the run (Sky Climb: no checkpoints, no auto reset — this is the one way back to zero). */
  resetPad?: { x: number; z: number; r: number };
  /** The run was wiped at the reset pad. */
  onAbort?: () => void;
  /** The runner fell a long way back to the ground mid-run (climb). */
  onFell?: () => void;
  /** The finished run's recorded path — persisted as the ghost when it's a PB. */
  onGhostSamples?: (samples: GhostSample[]) => void;
}) {
  const startedAt = useRef<number | null>(null);
  const done = useRef(false);
  // fall tracking: watch height frame-to-frame; a long drop that stops = a landing
  const prevH = useRef(0);
  const fallPeak = useRef<number | null>(null);
  // the run's path, ~10Hz — becomes the translucent ghost you race next time
  const samples = useRef<GhostSample[]>([]);
  const lastSampleAt = useRef(0);
  useFrame(() => {
    if (done.current) return;
    const p = poseRef.current;
    const h = p.h ?? 0;
    // ── ghost recording
    if (startedAt.current !== null) {
      const el = Date.now() - startedAt.current;
      if (el - lastSampleAt.current > 100 && samples.current.length < 6000) {
        lastSampleAt.current = el;
        samples.current.push({ t: el, x: p.x, z: p.z, h });
      }
    }

    // ── landing feedback: thud + dust after any real drop (both run modes)
    const dh = h - prevH.current;
    if (dh < -0.04) {
      if (fallPeak.current === null) fallPeak.current = prevH.current;
    } else if (fallPeak.current !== null && Math.abs(dh) < 0.005) {
      const drop = fallPeak.current - h;
      if (drop > 2.2) {
        worldSfx.land(drop > 6);
        arcadeFx.land(p.x, h + 0.06, p.z, drop > 6);
        if (drop > 6) arcadeShake.add(0.22); // a HARD landing thumps the camera too
        // a LONG fall back to the ground mid-run — tell the HUD (the clock keeps
        // running; the reset pad by the start is the way to go again)
        if (drop > 8 && h < 1.2 && startedAt.current !== null) onFell?.();
      }
      fallPeak.current = null;
    }
    prevH.current = h;

    // ── the reset pad: stand on it mid-run and the run (timer included) wipes
    if (resetPad && startedAt.current !== null && h < 1.2 && Math.hypot(p.x - resetPad.x, p.z - resetPad.z) < resetPad.r) {
      startedAt.current = null;
      samples.current = [];
      lastSampleAt.current = 0;
      worldSfx.runReset();
      arcadeFx.checkpoint(resetPad.x, 0.6, resetPad.z);
      onAbort?.();
      return;
    }

    if (startedAt.current === null) {
      if (inRunBox(start, p.x, p.z, h)) {
        startedAt.current = Date.now();
        samples.current = [];
        lastSampleAt.current = 0;
        worldSfx.go(); // the run is LIVE — one clean beep, HUD flashes GO
        onStart(mode, startedAt.current);
      }
      return;
    }
    if (inRunBox(goal, p.x, p.z, h)) {
      done.current = true;
      // the finish should FEEL like a finish — confetti right over the runner
      arcadeFx.confetti(p.x, h + 2.6, p.z);
      onGhostSamples?.(samples.current);
      onFinish(mode, Date.now() - startedAt.current);
    }
  });
  return null;
}

// ── The ghost: your personal-best run, made flesh (well, made teal) ──────────
export interface GhostSample { t: number; x: number; z: number; h: number }

/** A translucent runner replaying the stored PB path while a live run is going.
 *  Beat it to the line and the NEW ghost is the one you just laid down. */
export function GhostPlayer({ mode, startedAt }: { mode: string; startedAt: number | null }) {
  const g = useRef<THREE.Group>(null);
  const idx = useRef(0);
  const data = useMemo<GhostSample[] | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(`axon-ghost-${mode}`);
      if (!raw) return null;
      const arr = JSON.parse(raw) as GhostSample[];
      return Array.isArray(arr) && arr.length > 4 ? arr : null;
    } catch {
      return null;
    }
  }, [mode]);
  useFrame(() => {
    const el = g.current;
    if (!el) return;
    if (!data || startedAt === null) {
      el.visible = false;
      idx.current = 0;
      return;
    }
    const e = Date.now() - startedAt;
    if (e >= data[data.length - 1].t) {
      el.visible = false; // the ghost has finished — it beat you to the line
      return;
    }
    if (e < data[idx.current]?.t) idx.current = 0;
    while (idx.current < data.length - 2 && data[idx.current + 1].t <= e) idx.current++;
    const a = data[idx.current];
    const b = data[Math.min(idx.current + 1, data.length - 1)];
    const k = b.t > a.t ? (e - a.t) / (b.t - a.t) : 0;
    el.visible = true;
    el.position.set(a.x + (b.x - a.x) * k, a.h + (b.h - a.h) * k, a.z + (b.z - a.z) * k);
  });
  return (
    <group ref={g} visible={false}>
      {/* a runner-shaped wisp: capsule body + head, unlit teal, no shadows */}
      <mesh position={[0, 0.85, 0]}>
        <capsuleGeometry args={[0.32, 0.9, 4, 10]} />
        <meshBasicMaterial color="#3ee6d2" transparent opacity={0.32} depthWrite={false} />
      </mesh>
      <mesh position={[0, 1.62, 0]}>
        <sphereGeometry args={[0.22, 10, 8]} />
        <meshBasicMaterial color="#7ef2e4" transparent opacity={0.4} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ── Gauntlet hazards: ponds + sweepers reset you to the last checkpoint ──────
export type GauntletResetReason = "oob" | "pond" | "sweeper" | "crusher";

export function GauntletHazards({
  poseRef,
  runningRef,
  onReset,
  onCp,
}: {
  poseRef: { current: { x: number; z: number; h?: number } };
  /** Only reset while a run is live (no punishing spectators). */
  runningRef: { current: boolean };
  onReset: (cp: { x: number; z: number }, reason: GauntletResetReason) => void;
  /** Checkpoint registered — (index reached, total checkpoints past the start). */
  onCp?: (idx: number, total: number) => void;
}) {
  const lastReset = useRef(0);
  const cpIdx = useRef(0); // ORDERED progress — the U cannot be short-cut
  const sweeperNear = useRef<boolean[]>(GAUNTLET_SWEEPERS.map(() => false));
  const sweeperWhooshAt = useRef<number[]>(GAUNTLET_SWEEPERS.map(() => 0));
  const stomperPrevC = useRef<number[]>(GAUNTLET_STOMPERS.map(() => 0));
  useEffect(() => {
    GAUNTLET_LIVE.cpIdx = 0; // a fresh attempt starts the beacon back at the gate
  }, []);
  useFrame((state) => {
    const now = performance.now();
    const p = poseRef.current;
    const h = p.h ?? 0;
    // ── hazard telegraphs FIRST — they play for anyone in the arena, running
    // or not (a crusher slamming beside you on the walk to the line still
    // thuds), and are never swallowed by reset immunity
    {
      const t = state.clock.elapsedTime;
      // a crusher hitting the deck NEAR you thuds, kicks dust, bumps the camera —
      // the slam is a felt event even when it misses
      for (let i = 0; i < GAUNTLET_STOMPERS.length; i++) {
        const s = GAUNTLET_STOMPERS[i];
        const c = ((t + s.phase) / s.period) % 1;
        if (stomperPrevC.current[i] < 0.74 && c >= 0.74 && c < 0.9) {
          const d = Math.hypot(p.x - s.x, p.z - s.z);
          if (d < 14) {
            worldSfx.slam(1 - d / 14);
            arcadeFx.land(s.x, 0.5, s.z, true);
            arcadeShake.add(Math.max(0, 0.34 - d * 0.022));
          }
        }
        stomperPrevC.current[i] = c;
      }
      // a sweeper arm announces itself as it cuts past your ears
      for (let i = 0; i < GAUNTLET_SWEEPERS.length; i++) {
        const s = GAUNTLET_SWEEPERS[i];
        const a = t * s.w + s.phase;
        const ex = s.cx + Math.cos(a) * s.r;
        const ez = s.cz + Math.sin(a) * s.r;
        const vx = ex - s.cx, vz = ez - s.cz;
        const wx = p.x - s.cx, wz = p.z - s.cz;
        const c2 = vx * vx + vz * vz;
        const tt = Math.max(0, Math.min(1, c2 > 0 ? (vx * wx + vz * wz) / c2 : 0));
        const dist = Math.hypot(p.x - (s.cx + vx * tt), p.z - (s.cz + vz * tt));
        const near = dist < 3.4 && h < 2.5;
        if (near && !sweeperNear.current[i] && now - sweeperWhooshAt.current[i] > 700) {
          sweeperWhooshAt.current[i] = now;
          worldSfx.whoosh();
        }
        sweeperNear.current[i] = near;
      }
    }
    // everything from here is RUN state — progress and resets only while live
    if (!runningRef.current) return;
    // advance progress when the NEXT checkpoint is touched (in order) — and
    // make it FELT: a ding, a teal burst at the flag, and the HUD counter ticks
    const next = GAUNTLET_CHECKPOINTS[cpIdx.current + 1];
    if (next && Math.hypot(p.x - next.x, p.z - next.z) < 6.5) {
      cpIdx.current++;
      GAUNTLET_LIVE.cpIdx = cpIdx.current; // the beacon jumps to the new anchor
      worldSfx.checkpoint();
      arcadeFx.checkpoint(next.x, 1.6, next.z);
      onCp?.(cpIdx.current, GAUNTLET_CHECKPOINTS.length - 1);
    }
    // 1500ms immunity after a reset — teetering on a pond edge must not chain-reset
    if (now - lastReset.current < 1500) return;
    const cp = GAUNTLET_CHECKPOINTS[cpIdx.current];
    // out of the corridor mid-course (walked around the hedges) → back inside
    const G = ARENAS.gauntlet;
    if (
      p.x > GAUNTLET_LANE_OOB.x1 &&
      p.x < GAUNTLET_LANE_OOB.x2 &&
      Math.abs(p.z - G.cz) > GAUNTLET_LANE_OOB.halfZ
    ) {
      lastReset.current = now;
      onReset(cp, "oob");
      return;
    }
    // in a pond, at water level — water flies where you went in
    for (const pond of GAUNTLET_PONDS) {
      if (h < 0.15 && p.x > pond.x1 && p.x < pond.x2 && p.z > pond.z1 && p.z < pond.z2) {
        lastReset.current = now;
        arcadeFx.splash(p.x, 0.2, p.z);
        onReset(cp, "pond");
        return;
      }
    }
    // flattened by a stomper — the piston head is LOW and you're under it
    if (h < 1.5) {
      const t = state.clock.elapsedTime;
      for (const s of GAUNTLET_STOMPERS) {
        if (stomperHeadY(s, t) < 1.35 && Math.abs(p.x - s.x) < 1.15 && Math.abs(p.z - s.z) < 1.15) {
          lastReset.current = now;
          onReset(cp, "crusher");
          return;
        }
      }
    }
    // clipped by a sweeper arm (point-to-segment distance in 2D, low heights only)
    if (h < 1.3) {
      const t = state.clock.elapsedTime;
      for (const s of GAUNTLET_SWEEPERS) {
        const a = t * s.w + s.phase;
        const ex = s.cx + Math.cos(a) * s.r;
        const ez = s.cz + Math.sin(a) * s.r;
        const vx = ex - s.cx, vz = ez - s.cz;
        const wx = p.x - s.cx, wz = p.z - s.cz;
        const c1 = vx * wx + vz * wz;
        const c2 = vx * vx + vz * vz;
        const tt = Math.max(0, Math.min(1, c2 > 0 ? c1 / c2 : 0));
        const dx = p.x - (s.cx + vx * tt), dz = p.z - (s.cz + vz * tt);
        if (Math.hypot(dx, dz) < 0.95) {
          lastReset.current = now;
          onReset(cp, "sweeper");
          return;
        }
      }
    }
  });
  return null;
}

// ── Recognisable weapon models (carousel + first-person viewmodel) ───────────
// Built to READ at a glance: the shotgun has its double barrel and pump, the
// SMG its stubby body and long magazine, the rifle its scope and long barrel.
export function WeaponModel({ id }: { id: "pistol" | "revolver" | "smg" | "m4" | "shotgun" | "sniper" }) {
  const GUN = "#2e3238";
  const DARK = "#1e2226";
  const WOODY = "#6b4a2a";
  if (id === "shotgun") {
    return (
      <group>
        {/* double barrels, muzzle rings */}
        {[-0.045, 0.045].map((dx) => (
          <mesh key={dx} position={[dx, 0.02, -0.25]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.038, 0.038, 0.85, 10]} />
            <meshStandardMaterial color={GUN} metalness={0.6} roughness={0.35} />
          </mesh>
        ))}
        {[-0.045, 0.045].map((dx) => (
          <mesh key={`m${dx}`} position={[dx, 0.02, -0.66]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.048, 0.048, 0.04, 10]} />
            <meshStandardMaterial color={DARK} metalness={0.6} roughness={0.3} />
          </mesh>
        ))}
        {/* pump grip under the barrels */}
        <mesh position={[0, -0.05, -0.32]}>
          <boxGeometry args={[0.12, 0.09, 0.3]} />
          <meshStandardMaterial color={WOODY} roughness={0.7} />
        </mesh>
        {/* receiver + trigger guard */}
        <mesh position={[0, 0, 0.08]}>
          <boxGeometry args={[0.11, 0.14, 0.34]} />
          <meshStandardMaterial color={GUN} metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, -0.09, 0.12]} rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.05, 0.014, 6, 10, Math.PI]} />
          <meshStandardMaterial color={DARK} metalness={0.5} roughness={0.4} />
        </mesh>
        {/* wooden stock, angled */}
        <mesh position={[0, -0.05, 0.38]} rotation={[0.22, 0, 0]}>
          <boxGeometry args={[0.1, 0.16, 0.36]} />
          <meshStandardMaterial color={WOODY} roughness={0.7} />
        </mesh>
      </group>
    );
  }
  if (id === "m4") {
    return (
      <group>
        {/* barrel + front sight + rail */}
        <mesh position={[0, 0.02, -0.36]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.028, 0.032, 0.5, 10]} />
          <meshStandardMaterial color={GUN} metalness={0.6} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0.08, -0.5]}>
          <boxGeometry args={[0.02, 0.08, 0.03]} />
          <meshStandardMaterial color={DARK} roughness={0.4} />
        </mesh>
        {/* receiver with carry handle */}
        <mesh position={[0, 0, 0.02]}>
          <boxGeometry args={[0.1, 0.13, 0.5]} />
          <meshStandardMaterial color={GUN} metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.1, 0.06]}>
          <boxGeometry args={[0.04, 0.06, 0.24]} />
          <meshStandardMaterial color={DARK} roughness={0.45} />
        </mesh>
        {/* curved mag + grip + telescoping stock */}
        <mesh position={[0, -0.15, -0.05]} rotation={[0.35, 0, 0]}>
          <boxGeometry args={[0.07, 0.24, 0.11]} />
          <meshStandardMaterial color={DARK} roughness={0.5} />
        </mesh>
        <mesh position={[0, -0.11, 0.16]} rotation={[0.4, 0, 0]}>
          <boxGeometry args={[0.07, 0.16, 0.1]} />
          <meshStandardMaterial color={GUN} roughness={0.5} />
        </mesh>
        <mesh position={[0, -0.01, 0.38]}>
          <boxGeometry args={[0.06, 0.1, 0.26]} />
          <meshStandardMaterial color={DARK} roughness={0.5} />
        </mesh>
      </group>
    );
  }
  if (id === "revolver") {
    return (
      <group>
        {/* barrel with top rib */}
        <mesh position={[0, 0.03, -0.2]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.028, 0.028, 0.34, 10]} />
          <meshStandardMaterial color="#4a5058" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.065, -0.2]}>
          <boxGeometry args={[0.02, 0.02, 0.34]} />
          <meshStandardMaterial color="#3a3f47" metalness={0.6} roughness={0.35} />
        </mesh>
        {/* the CYLINDER — six chambers */}
        <mesh position={[0, 0.02, 0.0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.055, 0.055, 0.12, 6]} />
          <meshStandardMaterial color="#4a5058" metalness={0.7} roughness={0.3} flatShading />
        </mesh>
        {/* frame + hammer + wooden grip */}
        <mesh position={[0, 0.02, 0.1]}>
          <boxGeometry args={[0.05, 0.1, 0.14]} />
          <meshStandardMaterial color="#4a5058" metalness={0.6} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0.09, 0.16]} rotation={[-0.5, 0, 0]}>
          <boxGeometry args={[0.02, 0.06, 0.03]} />
          <meshStandardMaterial color="#3a3f47" metalness={0.6} roughness={0.35} />
        </mesh>
        <mesh position={[0, -0.09, 0.15]} rotation={[0.45, 0, 0]}>
          <boxGeometry args={[0.06, 0.16, 0.09]} />
          <meshStandardMaterial color="#5b3a22" roughness={0.7} />
        </mesh>
        <mesh position={[0, -0.04, 0.05]} rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.04, 0.012, 6, 10, Math.PI]} />
          <meshStandardMaterial color={DARK} metalness={0.5} roughness={0.4} />
        </mesh>
      </group>
    );
  }
  if (id === "sniper") {
    return (
      <group>
        {/* LONG barrel + muzzle brake */}
        <mesh position={[0, 0.02, -0.52]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.032, 0.036, 1.1, 10]} />
          <meshStandardMaterial color={GUN} metalness={0.6} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0.02, -1.04]}>
          <boxGeometry args={[0.07, 0.07, 0.12]} />
          <meshStandardMaterial color={DARK} metalness={0.6} roughness={0.3} />
        </mesh>
        {/* bipod folded under the barrel */}
        {[-0.03, 0.03].map((dx) => (
          <mesh key={dx} position={[dx, -0.06, -0.62]} rotation={[0.3, 0, dx > 0 ? -0.15 : 0.15]}>
            <cylinderGeometry args={[0.008, 0.008, 0.16, 6]} />
            <meshStandardMaterial color={DARK} metalness={0.5} roughness={0.4} />
          </mesh>
        ))}
        {/* receiver */}
        <mesh position={[0, 0, 0.05]}>
          <boxGeometry args={[0.09, 0.13, 0.5]} />
          <meshStandardMaterial color={GUN} metalness={0.5} roughness={0.4} />
        </mesh>
        {/* the SCOPE — long tube, flared ends, blue-glass objective */}
        <mesh position={[0, 0.13, 0.0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.045, 0.045, 0.42, 12]} />
          <meshStandardMaterial color={DARK} metalness={0.5} roughness={0.3} />
        </mesh>
        {[-0.2, 0.2].map((dz) => (
          <mesh key={`fl${dz}`} position={[0, 0.13, dz]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.055, 0.045, 0.05, 12]} />
            <meshStandardMaterial color={DARK} metalness={0.5} roughness={0.3} />
          </mesh>
        ))}
        <mesh position={[0, 0.13, -0.235]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.045, 0.045, 0.005, 12]} />
          <meshStandardMaterial color="#7ec3d8" emissive="#3a8fb8" emissiveIntensity={0.6} metalness={0.3} roughness={0.2} />
        </mesh>
        {[-0.06, 0.1].map((dz) => (
          <mesh key={dz} position={[0, 0.08, dz + 0.02]}>
            <boxGeometry args={[0.03, 0.06, 0.03]} />
            <meshStandardMaterial color={GUN} metalness={0.5} roughness={0.4} />
          </mesh>
        ))}
        {/* magazine + grip + stock with cheek riser */}
        <mesh position={[0, -0.13, 0.0]} rotation={[0.25, 0, 0]}>
          <boxGeometry args={[0.07, 0.2, 0.11]} />
          <meshStandardMaterial color={DARK} roughness={0.5} />
        </mesh>
        <mesh position={[0, -0.11, 0.22]} rotation={[0.4, 0, 0]}>
          <boxGeometry args={[0.07, 0.16, 0.1]} />
          <meshStandardMaterial color={GUN} roughness={0.5} />
        </mesh>
        <mesh position={[0, -0.02, 0.44]}>
          <boxGeometry args={[0.08, 0.12, 0.3]} />
          <meshStandardMaterial color={GUN} roughness={0.5} />
        </mesh>
      </group>
    );
  }
  if (id === "smg") {
    return (
      <group>
        {/* stubby body + short barrel with foregrip */}
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.11, 0.16, 0.44]} />
          <meshStandardMaterial color={GUN} metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.02, -0.3]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.03, 0.03, 0.2, 8]} />
          <meshStandardMaterial color={DARK} metalness={0.6} roughness={0.3} />
        </mesh>
        <mesh position={[0, -0.1, -0.16]}>
          <boxGeometry args={[0.06, 0.12, 0.08]} />
          <meshStandardMaterial color={DARK} roughness={0.5} />
        </mesh>
        {/* LONG curved magazine — the smg silhouette */}
        <mesh position={[0, -0.2, 0.02]} rotation={[0.35, 0, 0]}>
          <boxGeometry args={[0.07, 0.3, 0.1]} />
          <meshStandardMaterial color={DARK} roughness={0.5} />
        </mesh>
        {/* folding stock */}
        <mesh position={[0, 0.01, 0.32]}>
          <boxGeometry args={[0.04, 0.05, 0.24]} />
          <meshStandardMaterial color={GUN} metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, -0.03, 0.44]}>
          <boxGeometry args={[0.04, 0.12, 0.04]} />
          <meshStandardMaterial color={GUN} metalness={0.5} roughness={0.4} />
        </mesh>
      </group>
    );
  }
  // pistol
  return (
    <group>
      <mesh position={[0, 0.01, -0.08]}>
        <boxGeometry args={[0.08, 0.1, 0.36]} />
        <meshStandardMaterial color={GUN} metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.02, -0.28]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.024, 0.024, 0.1, 8]} />
        <meshStandardMaterial color={DARK} metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh position={[0, -0.1, 0.04]} rotation={[0.3, 0, 0]}>
        <boxGeometry args={[0.07, 0.18, 0.1]} />
        <meshStandardMaterial color="#4a3b2a" roughness={0.7} />
      </mesh>
      <mesh position={[0, -0.05, -0.05]} rotation={[0, 0, Math.PI / 2]}>
        <torusGeometry args={[0.04, 0.012, 6, 10, Math.PI]} />
        <meshStandardMaterial color={DARK} metalness={0.5} roughness={0.4} />
      </mesh>
    </group>
  );
}

// ── Zombie Waves: the whole survival loop ─────────────────────────────────────
// Wave n brings 3 + 2n zombies, trickling in from the graveyard's edge (never
// more than MAX_ALIVE at once); every 5th wave is led by a boss. Zombies hunt
// the player and bite on contact. Click (first person) or F fires the pistol
// toward where the CAMERA looks. No timer — it ends when you do, and the wave
// you fell on is your score.
export interface WaveHud {
  hp: number;
  kills: number;
  wave: number;
  breather: boolean; // between waves
  breatherLeft: number; // seconds until the next wave hits (0 = none)
  banner: string | null; // "WAVE 5" / "WAVE CLEARED" — the announce moment
  hurtAt: number; // last time a zombie connected (drives the red flash)
  hitAt: number; // last bolt that connected (crosshair hit marker)
  killAt: number; // last kill (bigger red pulse)
  critAt: number; // last HEADSHOT (gold pulse)
  popupAmt: number; // points bounty for the floating "+N"
  popupAt: number;
  points: number; // kill currency — spend at the Mystery Box
  weapon: string; // what you're holding
  mag: number; // rounds left in the magazine
  magsLeft: number; // spare magazines
  reloading: boolean;
  zoomed: boolean; // sniper scope engaged
  boxPrompt: string | null; // contextual Mystery Box prompt (near it)
  boxMsg: string | null; // toast: drops, box results
  power: string | null; // active power-up (insta-kill) label, or null
  combo: number; // current kill streak (0 = no streak showing)
  comboMult: number; // the active points multiplier the streak has earned
  comboAt: number; // last streak kill — the HUD bar drains from here
  boss: number | null; // live boss HP fraction (0..1), null when no boss up
  bossAt: number; // the boss's entrance — drives the red flash
  grenades: number; // pocket answer count — G to throw
}

// ── Kill combo: chain kills inside the window and the bounty multiplies ──────
// x2 at 4, x3 at 8, x4 at 12 — greed the horde punishes, since one bite wipes it.
export const COMBO_WINDOW_MS = 3000;
const comboMult = (c: number): number => (c >= 12 ? 4 : c >= 8 ? 3 : c >= 4 ? 2 : 1);

interface Zombie {
  x: number;
  z: number;
  hp: number;
  alive: boolean;
  boss: boolean;
  kind: ZombieKind | "boss";
  dieAt: number; // corpse window — the fall animation plays before the slot frees
  seed: number;
  hitCooldownUntil: number;
}

const DROP_DIRS: [number, number, number][] = [
  [0.9, 0.2, 0.4], [-0.7, 0.6, 0.1], [0.2, -0.85, 0.6], [-0.4, -0.5, 0.2], [0.55, 0.75, 0.5],
];
// Per-weapon bolt speed — the sniper round is nearly instant; buckshot is slower.
function boltSpeed(id: string): number {
  return id === "sniper" ? 340 : id === "m4" ? 210 : id === "revolver" ? 200 : id === "shotgun" ? 130 : 155;
}
// Reused every frame for the bolt instancing — allocating these inside useFrame
// caused GC pauses (the "random freezes"). Hoisted to module scope.
const BOLT_Q = new THREE.Quaternion();
const BOLT_UP = new THREE.Vector3(0, 1, 0);
const BOLT_DIR = new THREE.Vector3();
const BOLT_POS = new THREE.Vector3();
const BOLT_SCL = new THREE.Vector3(1, 1, 1);
const ZOMBIE_CAP = 24; // hard render cap
const WEAPON_IDS = ["pistol", "revolver", "smg", "m4", "shotgun", "sniper"] as const;

// The manager writes the wave's ground speed here every frame; every zombie
// figure reads it to pick its gait — SHAMBLE at low waves, a full SPRINT with
// pumping arms once the horde starts running (speed > 4.3).
export const ZOMBIE_GAIT = { speed: 2.3 };

// Per-slot animation channel — the manager mutates these in place (the poseRef
// pattern): what the zombie IS (kind) and what just happened to it.
export interface ZombieAnim {
  kind: ZombieKind | "boss";
  attackAt: number; // last bite lunge
  dieAt: number; // the moment it died — drives the fall
  hitAt: number; // last bolt that landed — drives the flinch
}

function ZombieFigure({ boss, seed, idx, anims }: { boss: boolean; seed: number; idx: number; anims: { current: ZombieAnim[] } }) {
  const root = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const belly = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const anim = anims.current[idx];
    const now = Date.now();
    const kind = anim.kind;
    const crawler = kind === "crawler";
    const gait = boss ? 2.0 : ZOMBIE_GAIT.speed;
    const sprinting = !boss && (kind === "runner" || gait > 4.3);
    const t = state.clock.elapsedTime * (sprinting ? 9.5 : crawler ? 5.2 : 3.4) + seed * 7;
    const amp = sprinting ? 0.72 : crawler ? 0.45 : 0.3;
    // ── death: it FALLS, it doesn't vanish — the manager hides it after ~700ms
    if (root.current) {
      if (anim.dieAt > 0) {
        const k = Math.min(1, (now - anim.dieAt) / 650);
        root.current.rotation.x = -k * 1.35;
        root.current.position.y = -k * 0.12;
      } else {
        root.current.rotation.x = 0;
        root.current.position.y = 0;
        const kindScale = kind === "runner" ? 0.92 : kind === "exploder" ? 1.06 : 1;
        root.current.scale.setScalar((boss ? 1.75 : 1) * kindScale);
      }
    }
    // legs swing from the hip — an actual stride, not a hop
    if (legL.current) legL.current.rotation.x = Math.sin(t) * amp;
    if (legR.current) legR.current.rotation.x = -Math.sin(t) * amp;
    // ── the bite lunge: arms SNAP forward + the body pitches into it
    const lunge = anim.attackAt > 0 ? Math.max(0, 1 - (now - anim.attackAt) / 420) : 0;
    // the flinch: a landed bolt ROCKS the body back for ~200ms — bullets have
    // somewhere to go now, instead of vanishing into a shove
    const flinch = anim.hitAt > 0 ? Math.max(0, 1 - (now - anim.hitAt) / 200) : 0;
    if (body.current) {
      body.current.rotation.z = Math.sin(t * 0.5) * (sprinting ? 0.03 : 0.07);
      // crawlers go on all fours; sprinters throw their weight; shamblers barely lean
      const lean = crawler ? 1.18 : sprinting ? 0.42 : 0.16;
      body.current.rotation.x += ((lean + lunge * 0.3 - flinch * 0.42) - body.current.rotation.x) * (flinch > 0.05 ? 0.5 : 0.12);
      body.current.position.y = crawler ? -0.55 : 0;
    }
    const armBase = crawler ? -2.3 : sprinting ? -1.0 : -1.35;
    const lungeArm = lunge > 0 ? -2.05 * lunge : 0;
    if (armL.current) armL.current.rotation.x = lunge > 0.05 ? armBase * (1 - lunge) + lungeArm : armBase + Math.sin(t) * (sprinting ? 0.55 : 0.18);
    if (armR.current) armR.current.rotation.x = lunge > 0.05 ? armBase * (1 - lunge) + lungeArm : armBase + (sprinting ? -Math.sin(t) * 0.55 : Math.cos(t * 1.1) * 0.18);
    // ── the exploder's belly breathes faster the closer it is to going off
    if (belly.current) {
      belly.current.visible = kind === "exploder";
      if (kind === "exploder") {
        const m = belly.current.material as THREE.MeshStandardMaterial;
        m.emissiveIntensity = 1.1 + Math.sin(state.clock.elapsedTime * 7 + seed) * 0.7;
      }
    }
  });
  const skin = boss ? "#5f8a4a" : seed % 2 > 1 ? "#86a868" : "#7da05f";
  const shirt = boss ? "#3a2f2a" : seed % 3 > 1.5 ? "#54432f" : "#4a5d3a";
  return (
    <group ref={root}>
      {/* minimal figure — many alive at once, so every mesh is a draw call
          multiplied by the horde. Legs + arms are hip/shoulder groups the gait
          loop swings; the head carries two glowing eyes. */}
      <group ref={body} rotation={[0.16, 0, 0]}>
        <group ref={legL} position={[-0.16, 0.84, 0]}>
          <mesh position={[0, -0.42, 0]}><boxGeometry args={[0.24, 0.84, 0.26]} /><meshStandardMaterial color="#332f2a" roughness={1} /></mesh>
        </group>
        <group ref={legR} position={[0.16, 0.84, 0.02]}>
          <mesh position={[0, -0.42, 0]}><boxGeometry args={[0.24, 0.84, 0.26]} /><meshStandardMaterial color="#3a3630" roughness={1} /></mesh>
        </group>
        {/* torso — torn shirt (the horde's one shadow-caster: cheap, grounds it) */}
        <mesh position={[0, 1.12, 0]} castShadow><boxGeometry args={[0.62, 0.72, 0.36]} /><meshStandardMaterial color={shirt} roughness={1} /></mesh>
        {/* the exploder's volatile gut */}
        <mesh ref={belly} position={[0, 0.98, 0.16]} visible={false}>
          <sphereGeometry args={[0.26, 10, 8]} />
          <meshStandardMaterial color="#9adf4e" emissive="#7ac832" emissiveIntensity={1.2} toneMapped={false} roughness={0.5} />
        </mesh>
        {/* arms out front, groping */}
        <group ref={armL} position={[-0.38, 1.38, 0]}>
          <mesh position={[0, -0.34, 0]}><boxGeometry args={[0.18, 0.68, 0.18]} /><meshStandardMaterial color={skin} roughness={1} /></mesh>
        </group>
        <group ref={armR} position={[0.38, 1.34, 0]}>
          <mesh position={[0, -0.36, 0]}><boxGeometry args={[0.18, 0.72, 0.18]} /><meshStandardMaterial color={skin} roughness={1} /></mesh>
        </group>
        {/* head + two glowing eyes */}
        <group position={[0, 1.72, 0]} rotation={[0.08, 0, -0.12]}>
          <mesh><boxGeometry args={[0.42, 0.42, 0.4]} /><meshStandardMaterial color={skin} roughness={1} /></mesh>
          {[-0.1, 0.1].map((dx) => (
            <mesh key={dx} position={[dx, 0.03, 0.21]}><boxGeometry args={[0.06, 0.05, 0.03]} /><meshStandardMaterial color={boss ? "#ff3333" : "#e8e14a"} emissive={boss ? "#ff2222" : "#d8d13a"} emissiveIntensity={1.6} toneMapped={false} /></mesh>
          ))}
        </group>
      </group>
    </group>
  );
}

// The run's story, handed up with the final wave for the death recap.
export interface ZombieRunStats {
  kills: number;
  points: number;
  shots: number;
  hits: number;
  crits: number;
}

export function ZombieWavesManager({
  poseRef,
  firstPerson,
  onHud,
  onEnd,
}: {
  poseRef: { current: { x: number; z: number; ry: number; h?: number } };
  firstPerson: boolean;
  onHud: (h: WaveHud) => void;
  onEnd: (wave: number, stats: ZombieRunStats) => void;
}) {
  const f = ARENAS.arena;
  const { camera } = useThree();
  // Fixed slots: 0..19 normal zombies, 20..23 bosses — the figure meshes are
  // static per slot, the manager only toggles visibility/position.
  const zombies = useRef<Zombie[]>(
    Array.from({ length: ZOMBIE_CAP }, (_, i) => ({
      x: 0, z: 0, hp: 0, alive: false, boss: i >= 20, kind: (i >= 20 ? "boss" : "normal") as Zombie["kind"], dieAt: 0, seed: i * 1.37, hitCooldownUntil: 0,
    })),
  );
  // per-slot animation channels the figures read (mutated in place, poseRef-style)
  const zAnims = useRef<ZombieAnim[]>(
    Array.from({ length: ZOMBIE_CAP }, (_, i) => ({ kind: (i >= 20 ? "boss" : "normal") as ZombieAnim["kind"], attackAt: 0, dieAt: 0, hitAt: 0 })),
  );
  // The horde's brain — one Yuka steering vehicle per slot. Seek chases the
  // player, Separation stops the stack-into-one-column look (they fan out and
  // flank), a whisper of Wander keeps the shamble organic. Yuka only PROPOSES
  // movement: every frame the vehicle position is re-clamped by our own
  // deterministic colliders (resolvePlatXZ + the fence ring), which stay
  // authoritative — same collision behaviour as before, better crowd feel.
  const yuka = useRef<{ em: EntityManager; targetVec: YVector3; vehicles: Vehicle[] } | null>(null);
  useEffect(() => {
    const em = new EntityManager();
    const targetVec = new YVector3();
    const vehicles = Array.from({ length: ZOMBIE_CAP }, (_, i) => {
      const v = new Vehicle();
      v.maxForce = 40; // snappy steering — matches the old instant-turn feel
      v.boundingRadius = i >= 20 ? 1.5 : 1.0; // slots 20+ are the bosses
      v.updateNeighborhood = true;
      v.neighborhoodRadius = 3;
      const sep = new SeparationBehavior();
      sep.weight = 1.8;
      const wander = new WanderBehavior();
      wander.weight = 0.3;
      v.steering.add(new SeekBehavior(targetVec));
      v.steering.add(sep);
      v.steering.add(wander);
      v.active = false;
      em.add(v);
      return v;
    });
    yuka.current = { em, targetVec, vehicles };
    return () => {
      yuka.current = null;
    };
  }, []);
  const bolts = useRef<{ x: number; y: number; z: number; dx: number; dy: number; dz: number; sp: number; life: number; dmg: number }[]>([]);
  const splats = useRef<{ x: number; z: number; at: number }[]>([]);
  const splatRefs = useRef<(THREE.Group | null)[]>([]);
  const st = useRef({
    hp: 100,
    dropsThisWave: 0,
    mag: WEAPONS.pistol.magSize,
    magsLeft: WEAPONS.pistol.mags,
    reloadUntil: 0,
    kills: 0,
    wave: 1,
    toSpawn: WAVE_SIZE(1),
    bossToSpawn: WAVE_HAS_BOSS(1),
    nextSpawnAt: 0,
    breatherUntil: 0,
    done: false,
    lastFire: 0,
    hurtAt: 0,
    points: 0,
    weapon: WEAPONS.pistol as WeaponDef,
    nearBox: false,
    boxMsg: "",
    boxMsgUntil: 0,
    // the Mystery Box ritual: pay → the lid opens and weapons spin → an offer
    // hovers — TAKE it (E) or walk away and keep what you have.
    boxState: "idle" as "idle" | "spinning" | "offering",
    boxSpinStart: 0,
    boxOffer: null as WeaponDef | null,
    boxOfferUntil: 0,
    instaUntil: 0,
    // announce moments + shot feedback (all HUD-driven)
    lastBannerWave: 0, // which wave's banner already showed
    banner: "",
    bannerUntil: 0,
    lastDryAt: 0, // rate-limits the dry-fire click
    hitAt: 0, // crosshair hit-marker pulse
    killAt: 0, // kill-confirm pulse (red, bigger)
    critAt: 0, // headshot pulse (gold)
    popupAmt: 0, // floating "+N" points popup
    popupAt: 0,
    // the run's story — surfaced on the death recap
    maxHp: 100, // the VIGOR perk raises this once per run
    perkOwned: false,
    shots: 0,
    hitsTally: 0,
    crits: 0,
    // grenades: the pocket crowd answer; MAX AMMO restocks them
    grenades: GRENADES_START,
    // QUICK HANDS: the second perk — reloads at ~half speed once owned
    perk2Owned: false,
    reloadDur: RELOAD_MS, // the ACTIVE reload's duration (perk-aware)
    // kill combo — streak count + the moment of the last streak kill
    combo: 0,
    comboAt: 0,
    // boss drama — entrance slow-mo window, live boss health, the flash moment
    bossSlowUntil: 0,
    bossMaxHp: 1,
    bossAt: 0,
    // hit-stop: heavy impacts freeze the horde for a few frames — weight
    freezeUntil: 0,
    // low-HP heartbeat cadence
    nextHeartbeatAt: 0,
  });
  const drops = useRef<{ x: number; z: number; kind: DropKind; at: number }[]>([]);
  const nades = useRef<{ x: number; y: number; z: number; vx: number; vy: number; vz: number; bornAt: number }[]>([]);
  const nadeRefs = useRef<(THREE.Group | null)[]>([]);
  const dropRefs = useRef<(THREE.Group | null)[]>([]);
  const lastHud = useRef<WaveHud>({ hp: -1, kills: -1, wave: -1, breather: false, breatherLeft: 0, banner: null, hurtAt: 0, hitAt: 0, killAt: 0, critAt: 0, popupAmt: 0, popupAt: 0, points: -1, weapon: "", mag: -1, magsLeft: -1, reloading: false, zoomed: false, boxPrompt: null, boxMsg: null, power: null, combo: 0, comboMult: 1, comboAt: 0, boss: null, bossAt: 0, grenades: -1 });
  const trigger = useRef(false); // held for auto weapons
  const zoomHeld = useRef(false); // right mouse — sniper scope
  const bobT = useRef(0); // viewmodel walk-bob clock
  const prevGunPos = useRef({ x: 0, z: 0 }); // planar speed estimate for the bob
  const baseFov = useRef<number | null>(null);
  const zRefs = useRef<(THREE.Group | null)[]>([]);
  const boltMesh = useRef<THREE.InstancedMesh>(null);
  const gunRef = useRef<THREE.Group>(null);
  const muzzleLight = useRef<THREE.PointLight>(null);
  const vmRefs = useRef<Record<string, THREE.Group | null>>({});
  const boxRef = useRef<THREE.Group>(null);
  const boxLidRef = useRef<THREE.Group>(null);
  const boxBeamRef = useRef<THREE.Mesh>(null);
  const boxWeaponRefs = useRef<(THREE.Group | null)[]>([]);
  const spawnCounter = useRef(0);
  const m4 = useRef(new THREE.Matrix4());
  const camDir = useRef(new THREE.Vector3());

  // fire: LEFT MOUSE only (hold it for automatics); right mouse aims the sniper.
  // No keyboard fire — F did nothing but cause accidents.
  useEffect(() => {
    const fire = () => {
      const s = st.current;
      const now = Date.now();
      if (s.done || now < s.reloadUntil || now - s.lastFire < s.weapon.fireMs) return;
      if (s.mag <= 0) {
        // auto-reload when the mag runs dry (if there's a spare)
        if (s.magsLeft > 0 && now >= s.reloadUntil) {
          s.magsLeft--;
          s.reloadDur = s.perk2Owned ? Math.round(RELOAD_MS * ZOMBIE_PERK2.reloadMul) : RELOAD_MS;
          s.reloadUntil = now + s.reloadDur;
          worldSfx.reloadStart();
        } else if (now - s.lastDryAt > 250) {
          // no spare mags either — the trigger clicks dry
          s.lastDryAt = now;
          worldSfx.dryFire();
        }
        return;
      }
      s.lastFire = now;
      s.mag--; // one trigger pull = one round (the shotgun shell holds its pellets)
      s.shots++; // accuracy is part of the recap
      worldSfx.shot(s.weapon.id);
      // every shot kicks the CAMERA too, scaled to the weapon's punch — the gun
      // recoil alone reads as animation; the trauma shake makes it a gunshot
      arcadeShake.add(
        s.weapon.id === "sniper" ? 0.3 : s.weapon.id === "shotgun" ? 0.27 : s.weapon.id === "revolver" ? 0.2
        : s.weapon.id === "m4" ? 0.11 : s.weapon.id === "smg" ? 0.08 : 0.12,
      );
      // shoot where the CAMERA looks — the FULL 3D direction, so aiming up fires
      // up and aiming down fires at the ground (not always level).
      camera.getWorldDirection(camDir.current);
      const d = camDir.current;
      const dlen = Math.hypot(d.x, d.y, d.z) || 1;
      const bx = d.x / dlen, by = d.y / dlen, bz = d.z / dlen;
      // hip-fire is loose; a scoped weapon is only pinpoint when you're aiming down it
      const scoped = s.weapon.zoom && zoomHeld.current;
      const hipPenalty = s.weapon.zoom && !scoped ? 9 : 1; // sniper from the hip sprays
      const p = poseRef.current;
      const sp = boltSpeed(s.weapon.id);
      const y0 = 1.32 + (p.h ?? 0); // eye height
      // ONE flash, AT the barrel: project the viewmodel's camera-space offset
      // (right 0.32, down 0.28, forward ~1.05 to the muzzle) into world space,
      // so the flash rides the gun tip instead of floating at eye height.
      const cm = camera.matrixWorld.elements;
      const mx = camera.position.x + cm[0] * 0.32 - cm[4] * 0.3 + bx * 1.05;
      const my = camera.position.y + cm[1] * 0.32 - cm[5] * 0.3 + by * 1.05;
      const mz = camera.position.z + cm[2] * 0.32 - cm[6] * 0.3 + bz * 1.05;
      arcadeFx.muzzle(mx, my, mz);
      // the rifles draw a hot line down-range for a frame — bloom does the rest
      if (s.weapon.id === "sniper" || s.weapon.id === "m4" || s.weapon.id === "revolver") {
        const reach = s.weapon.id === "sniper" ? 34 : 22;
        arcadeFx.tracer(mx, my, mz, mx + bx * reach, my + by * reach, mz + bz * reach);
      }
      for (let i = 0; i < s.weapon.pellets; i++) {
        const jitter = (Math.random() - 0.5) * 2 * s.weapon.spread * hipPenalty;
        const cs = Math.cos(jitter), sn = Math.sin(jitter);
        const dx = bx * cs - bz * sn, dz = bx * sn + bz * cs; // spread sprays horizontally
        bolts.current.push({ x: p.x + dx * 0.9, y: y0, z: p.z + dz * 0.9, dx, dy: by, dz, sp, life: 1.3, dmg: s.weapon.dmg });
      }
    };
    const boxInteract = () => {
      const s = st.current;
      const now = Date.now();
      if (s.done) return;
      if (s.nearBox) {
        if (s.boxState === "idle") {
          if (s.points < MYSTERY_BOX.cost) {
            s.boxMsg = `Need ${MYSTERY_BOX.cost} pts`;
            s.boxMsgUntil = now + 1500;
            return;
          }
          // pay to OPEN — the lid lifts and the box spins through weapons
          s.points -= MYSTERY_BOX.cost;
          s.boxState = "spinning";
          s.boxSpinStart = now;
          worldSfx.chest();
        } else if (s.boxState === "offering" && s.boxOffer) {
          // take the offer — fully stocked
          s.weapon = s.boxOffer;
          s.mag = s.boxOffer.magSize;
          s.magsLeft = s.boxOffer.mags;
          s.reloadUntil = 0;
          s.boxMsg = `You took: ${s.boxOffer.name.toUpperCase()}`;
          s.boxMsgUntil = now + 2400;
          s.boxState = "idle";
          s.boxOffer = null;
          worldSfx.pick();
        }
        return;
      }
      // wall-buys: a KNOWN gun at a KNOWN price — the box stays the gamble
      const p = poseRef.current;
      const buy = ZOMBIE_WALLBUYS.find((b) => Math.hypot(p.x - b.x, p.z - b.z) < 2.6);
      if (buy) {
        if (s.points < buy.cost) {
          s.boxMsg = `Need ${buy.cost} pts`;
          s.boxMsgUntil = now + 1500;
          return;
        }
        s.points -= buy.cost;
        s.weapon = WEAPONS[buy.weapon];
        s.mag = s.weapon.magSize;
        s.magsLeft = s.weapon.mags;
        s.reloadUntil = 0;
        s.boxMsg = `${s.weapon.name.toUpperCase()} — locked and loaded`;
        s.boxMsgUntil = now + 2200;
        worldSfx.purchase();
        return;
      }
      // the VIGOR perk: +50 max HP, once per run
      if (!s.perkOwned && Math.hypot(p.x - ZOMBIE_PERK.x, p.z - ZOMBIE_PERK.z) < 2.6) {
        if (s.points < ZOMBIE_PERK.cost) {
          s.boxMsg = `Need ${ZOMBIE_PERK.cost} pts`;
          s.boxMsgUntil = now + 1500;
          return;
        }
        s.points -= ZOMBIE_PERK.cost;
        s.perkOwned = true;
        s.maxHp = 100 + ZOMBIE_PERK.hpBonus;
        s.hp = Math.min(s.maxHp, s.hp + ZOMBIE_PERK.hpBonus);
        s.boxMsg = "VIGOR — +50 MAX HP";
        s.boxMsgUntil = now + 2400;
        worldSfx.purchase();
        return;
      }
      // QUICK HANDS: the reload perk, by the shed
      if (!s.perk2Owned && Math.hypot(p.x - ZOMBIE_PERK2.x, p.z - ZOMBIE_PERK2.z) < 2.6) {
        if (s.points < ZOMBIE_PERK2.cost) {
          s.boxMsg = `Need ${ZOMBIE_PERK2.cost} pts`;
          s.boxMsgUntil = now + 1500;
          return;
        }
        s.points -= ZOMBIE_PERK2.cost;
        s.perk2Owned = true;
        s.boxMsg = "QUICK HANDS — RELOADS ~2× FASTER";
        s.boxMsgUntil = now + 2400;
        worldSfx.purchase();
      }
    };
    fireRef.current = fire;
    // grenade: G key / touch — an arc throw toward where the camera looks
    const throwNade = () => {
      const s = st.current;
      const now = Date.now();
      if (s.done || s.grenades <= 0 || nades.current.length >= 3) return;
      s.grenades--;
      worldSfx.nadeThrow();
      camera.getWorldDirection(camDir.current);
      const d = camDir.current;
      const p = poseRef.current;
      nades.current.push({
        x: p.x + d.x * 0.7, y: 1.42 + (p.h ?? 0), z: p.z + d.z * 0.7,
        vx: d.x * 13, vy: Math.max(2.5, d.y * 10 + 5), vz: d.z * 13, bornAt: now,
      });
    };
    // manual reload — shared by the R key and the touch RELOAD button
    const doReload = () => {
      const s2 = st.current;
      const nowR = Date.now();
      if (!s2.done && s2.magsLeft > 0 && s2.mag < s2.weapon.magSize && nowR >= s2.reloadUntil) {
        s2.magsLeft--;
        s2.mag = 0; // the fresh mag seats when the reload completes
        s2.reloadDur = s2.perk2Owned ? Math.round(RELOAD_MS * ZOMBIE_PERK2.reloadMul) : RELOAD_MS;
        s2.reloadUntil = nowR + s2.reloadDur;
        worldSfx.reloadStart();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyE") boxInteract();
      if (e.code === "KeyR") doReload();
      if (e.code === "KeyG") throwNade();
    };
    const onTouchNade = () => throwNade();
    const onTouchReload = () => doReload();
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) { zoomHeld.current = true; return; }
      if (e.button !== 0) return;
      if (!(e.target instanceof HTMLCanvasElement)) return; // never UI clicks
      trigger.current = true;
      fire(); // semi-autos fire per click; automatics keep going via the trigger
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 2) zoomHeld.current = false;
      if (e.button === 0) trigger.current = false;
    };
    const onCtx = (e: Event) => { e.preventDefault(); }; // RMB = scope, not menu
    // touch FIRE button drives the same trigger
    const onTouchFire = (e: Event) => { trigger.current = (e as CustomEvent).detail === true; if (trigger.current) fire(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("contextmenu", onCtx);
    window.addEventListener("axon-fire", onTouchFire);
    window.addEventListener("axon-reload", onTouchReload);
    window.addEventListener("axon-grenade", onTouchNade);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("axon-fire", onTouchFire);
      window.removeEventListener("axon-reload", onTouchReload);
      window.removeEventListener("axon-grenade", onTouchNade);
    };
  }, [camera, poseRef]);
  const fireRef = useRef<() => void>(() => {});

  // The scope must never outlive the run: dying (or leaving) while zoomed used
  // to strand the whole world at telescope FOV — and the next run would adopt
  // it as the baseline. Capture the fov at mount, restore it on unmount.
  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera;
    const initialFov = persp.isPerspectiveCamera ? persp.fov : null;
    return () => {
      if (initialFov !== null && persp.isPerspectiveCamera) {
        persp.fov = initialFov;
        persp.updateProjectionMatrix();
      }
    };
  }, [camera]);

  useFrame((frameState, rawDt) => {
    const s = st.current;
    if (s.done) return;
    const dt = Math.min(rawDt, 0.05);
    const now = Date.now();
    const p = poseRef.current;
    const t = frameState.clock.elapsedTime;

    // automatics: the held trigger keeps firing
    if (trigger.current && s.weapon.auto) fireRef.current();
    // reload finishing — the fresh mag seats with a clack
    if (s.reloadUntil > 0 && now >= s.reloadUntil && s.mag === 0) {
      s.mag = s.weapon.magSize;
      s.reloadUntil = 0;
      worldSfx.reloadEnd();
    }
    // the sniper scope: hold right mouse to breathe in
    // (mutate frameState.camera — the compiler forbids touching the hook value)
    const wantZoom = !!(zoomHeld.current && s.weapon.zoom && firstPerson);
    const persp = frameState.camera as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera) {
      if (baseFov.current === null) baseFov.current = persp.fov;
      const targetFov = wantZoom ? 22 : baseFov.current;
      if (Math.abs(persp.fov - targetFov) > 0.1) {
        persp.fov += (targetFov - persp.fov) * 0.25;
        persp.updateProjectionMatrix();
      }
    }

    // ── the pistol viewmodel rides the camera (first person only)
    const gun = gunRef.current;
    if (gun) {
      gun.visible = firstPerson;
      if (firstPerson) {
        gun.position.copy(camera.position);
        gun.quaternion.copy(camera.quaternion);
        // recoil kick scaled by the weapon's punch
        const punch = s.weapon.id === "shotgun" ? 0.1 : s.weapon.id === "sniper" ? 0.09 : s.weapon.id === "revolver" ? 0.07 : 0.05;
        const kick = Math.max(0, 1 - (now - s.lastFire) / 130) * punch;
        // walk-bob: the gun breathes with your stride (planar speed → amplitude)
        const pp = poseRef.current;
        const spd = Math.min(1, Math.hypot(pp.x - prevGunPos.current.x, pp.z - prevGunPos.current.z) / Math.max(dt, 1e-4) / 8);
        prevGunPos.current.x = pp.x;
        prevGunPos.current.z = pp.z;
        bobT.current += dt * (4 + spd * 6);
        const bobY = Math.sin(bobT.current * 2) * 0.014 * spd;
        const bobX = Math.cos(bobT.current) * 0.009 * spd;
        // reload: the gun DIPS out of view and rises with the fresh mag
        const rp = s.reloadUntil > now ? 1 - (s.reloadUntil - now) / s.reloadDur : 0;
        const dip = Math.sin(Math.min(1, Math.max(0, rp)) * Math.PI) * 0.24;
        gun.translateX(0.32 + bobX);
        gun.translateY(-0.28 + kick * 0.4 + bobY - dip);
        gun.translateZ(-0.62 + kick);
        gun.rotateX(-dip * 0.8);
        // show the model of the weapon actually held
        for (const id of WEAPON_IDS) {
          const el = vmRefs.current[id];
          if (el) el.visible = id === s.weapon.id;
        }
        // the muzzle LIGHT: a one-flash point light at the barrel that the bloom
        // pass catches — every shot momentarily lights the graveyard around you
        const ml = muzzleLight.current;
        if (ml) {
          const flash = Math.max(0, 1 - (now - s.lastFire) / 75);
          ml.intensity = flash * (s.weapon.id === "shotgun" || s.weapon.id === "sniper" ? 7 : s.weapon.id === "revolver" ? 5 : 3.5);
        }
      }
    }

    // ── wave flow: breather → trickle spawns → clear → next wave
    const yk = yuka.current;
    if (!yk) return; // effects run before the first frame — this is a TS guard
    let aliveCount = 0;
    for (const z of zombies.current) if (z.alive) aliveCount++;
    if (s.breatherUntil > now) {
      // between waves — nothing spawns
    } else if (s.toSpawn > 0 || s.bossToSpawn) {
      if (now >= s.nextSpawnAt && aliveCount < MAX_ALIVE) {
        s.nextSpawnAt = now + 1400;
        const sp = ZOMBIE_SPAWNS[spawnCounter.current++ % ZOMBIE_SPAWNS.length];
        const boss = s.bossToSpawn && s.toSpawn === 0;
        if (boss) s.bossToSpawn = false;
        else s.toSpawn--;
        // a corpse keeps its slot until the fall finishes — no teleporting bodies
        const slotIdx = zombies.current.findIndex((z) => !z.alive && z.boss === boss && now > z.dieAt + 750);
        if (slotIdx >= 0) {
          const slot = zombies.current[slotIdx];
          const kind: Zombie["kind"] = boss ? "boss" : pickZombieKind(s.wave, Math.random());
          slot.x = sp.x;
          slot.z = sp.z;
          const baseHp = boss ? 22 + s.wave * 2 : 2 + Math.floor(s.wave / 4);
          slot.hp = boss ? baseHp : Math.max(1, Math.round(baseHp * ZOMBIE_KINDS[kind as ZombieKind].hpMul));
          slot.alive = true;
          slot.kind = kind;
          slot.dieAt = 0;
          slot.seed = spawnCounter.current * 1.37;
          slot.hitCooldownUntil = 0;
          const an = zAnims.current[slotIdx];
          an.kind = kind;
          an.attackAt = 0;
          an.dieAt = 0;
          an.hitAt = 0;
          // wake this slot's steering vehicle at the spawn point, standing still
          const v = yk.vehicles[slotIdx];
          v.position.set(sp.x, 0, sp.z);
          v.velocity.set(0, 0, 0);
          v.active = true;
          // ── the boss's ENTRANCE: a roar, a camera rumble, a beat of slow-mo
          // and a red wash — the fight announces its own arc (the HUD's boss
          // bar tracks it from here to the kill)
          if (boss) {
            s.bossMaxHp = slot.hp;
            s.bossAt = now;
            s.bossSlowUntil = now + 1200;
            worldSfx.bossRoar();
            arcadeShake.add(0.3);
          }
        }
      }
    } else if (aliveCount === 0) {
      // wave cleared — a breath of relief, then the countdown to the next horn
      s.wave++;
      s.toSpawn = WAVE_SIZE(s.wave);
      s.bossToSpawn = WAVE_HAS_BOSS(s.wave);
      s.breatherUntil = now + 3500;
      s.nextSpawnAt = now + 3500;
      s.dropsThisWave = 0;
      worldSfx.waveClear();
      s.banner = "WAVE CLEARED";
      s.bannerUntil = now + 1700;
    }
    // the wave ANNOUNCES itself: when the breather ends (or on wave 1), the horn
    // sounds and the banner drops — the player always knows a wave just began
    if (!s.done && now >= s.breatherUntil && s.lastBannerWave !== s.wave) {
      s.lastBannerWave = s.wave;
      s.banner = `WAVE ${s.wave}`;
      s.bannerUntil = now + 2200;
      worldSfx.waveHorn();
    }

    // ── shared death path: the corpse FALLS (dieAt drives the figure), the kill
    // pays its bounty, drops roll, and an exploder takes the neighbourhood with it
    const explodeAt = (z: Zombie): void => {
      worldSfx.boom();
      arcadeFx.explode(z.x, 1.0, z.z);
      const pp = poseRef.current;
      const blastDist = Math.hypot(pp.x - z.x, pp.z - z.z);
      // the boom rocks the camera by proximity, and stops time for a breath
      arcadeShake.add(Math.max(0, 0.5 - blastDist * 0.045));
      s.freezeUntil = Math.max(s.freezeUntil, now + 60);
      if (blastDist < EXPLODER_BLAST_DIST && (pp.h ?? 0) < 2.5) {
        s.hp = Math.max(0, s.hp - EXPLODER_BLAST_DMG);
        s.hurtAt = now;
        s.combo = 0; // taking a blast wipes the streak
        worldSfx.hurt();
      }
      // the blast chews nearby zombies too — chain kills pay out
      for (const o of zombies.current) {
        if (!o.alive || o === z) continue;
        if (Math.hypot(o.x - z.x, o.z - z.z) < 3.5) {
          o.hp -= 30;
          if (o.hp <= 0) killZombie(o, true);
        }
      }
    };
    const killZombie = (z: Zombie, credit: boolean): void => {
      const zi = zombies.current.indexOf(z);
      z.alive = false;
      z.dieAt = now;
      zAnims.current[zi].dieAt = now;
      yk.vehicles[zi].active = false;
      if (credit) {
        s.kills++;
        // ── the combo: kills inside the window chain, and the streak multiplies
        // the bounty — each streak kill blips a semitone higher
        if (now - s.comboAt < COMBO_WINDOW_MS) s.combo++;
        else s.combo = 1;
        s.comboAt = now;
        const mult = comboMult(s.combo);
        if (s.combo >= 4) worldSfx.comboTick(s.combo - 4);
        const bounty = (z.boss ? POINTS_PER_BOSS : ZOMBIE_KINDS[z.kind as ZombieKind].bounty) * mult;
        s.points += bounty;
        s.killAt = now; // kill-confirm pulse
        s.popupAmt = bounty; // floating "+N"
        s.popupAt = now;
        // dropping the BOSS is the run's biggest single moment — sell it
        if (z.boss) {
          s.freezeUntil = Math.max(s.freezeUntil, now + 80);
          arcadeShake.add(0.42);
        }
      }
      worldSfx.zombieDie();
      arcadeFx.zombieDie(z.x, z.boss ? 1.6 : 1.0, z.z, z.boss);
      // RARELY the dead pay it forward — a drop is an event, at most one
      // per wave from the horde (bosses always pay out)
      if ((z.boss || s.dropsThisWave < DROP_WAVE_CAP) && Math.random() < (z.boss ? BOSS_DROP_CHANCE : DROP_CHANCE)) {
        if (!z.boss) s.dropsThisWave++;
        if (drops.current.length >= 6) drops.current.shift();
        drops.current.push({ x: z.x, z: z.z, kind: DROP_KINDS[Math.floor(Math.random() * DROP_KINDS.length)], at: now });
      }
      if (z.kind === "exploder") explodeAt(z);
    };

    // ── bolts fly FAST: swept segment collision so nothing tunnels through
    const bs = bolts.current;
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i];
      const px = b.x, pz = b.z;
      b.x += b.dx * b.sp * dt;
      b.y += b.dy * b.sp * dt;
      b.z += b.dz * b.sp * dt;
      b.life -= dt;
      let dead = b.life <= 0;
      const segX = b.x - px, segZ = b.z - pz;
      const segLen2 = segX * segX + segZ * segZ;
      const distToSeg = (cx: number, cz: number) => {
        const t0 = segLen2 > 0 ? Math.max(0, Math.min(1, ((cx - px) * segX + (cz - pz) * segZ) / segLen2)) : 0;
        return Math.hypot(cx - (px + segX * t0), cz - (pz + segZ * t0));
      };
      if (!dead) {
        for (const c of ZOMBIE_PLATS) {
          // height-aware: a bolt ABOVE the slab's top sails over it — shooting
          // over a wall from a crate no longer eats the shot
          if (c.y > 1.1 && b.y < c.y && distToSeg(c.x, c.z) < Math.min(c.hw, c.hd)) { dead = true; break; }
        }
      }
      if (!dead) {
        for (const z of zombies.current) {
          if (!z.alive) continue;
          // the kind defines the hit column — crawlers are LOW, aim down
          const def = z.boss ? null : ZOMBIE_KINDS[z.kind as ZombieKind];
          const rad = z.boss ? 1.5 : def!.radius;
          const topY = z.boss ? 3.4 : def!.topY;
          if (b.y > -0.3 && b.y < topY && distToSeg(z.x, z.z) < rad) {
            // HEADSHOT: the top of the column, where a head lives (crawlers have no crit zone)
            const headMin = z.boss ? 2.55 : def!.headMin;
            const crit = headMin !== null && b.y >= headMin;
            z.hp -= s.instaUntil > now ? 999 : b.dmg * (crit ? HEADSHOT_MUL : 1);
            s.points += crit ? POINTS_PER_HIT * 2 : POINTS_PER_HIT;
            s.hitAt = now; // crosshair hit-marker pulse
            s.hitsTally++;
            if (crit) {
              s.crits++;
              s.critAt = now;
              worldSfx.crit();
            }
            dead = true;
            // blood puff + a shove backwards so the hit READS
            splats.current.push({ x: z.x, z: z.z, at: now });
            if (splats.current.length > 10) splats.current.shift();
            arcadeFx.zombieHit(z.x, Math.max(0.6, Math.min(b.y, topY - 0.3)), z.z);
            z.x += b.dx * 0.5;
            z.z += b.dz * 0.5;
            if (z.hp <= 0) {
              // a headshot KILL lands with a frame of hit-stop — weight, not lag
              if (crit) s.freezeUntil = Math.max(s.freezeUntil, now + 45);
              killZombie(z, true);
            } else {
              worldSfx.zombieHit();
              zAnims.current[zombies.current.indexOf(z)].hitAt = now; // the flinch
            }
            break;
          }
        }
      }
      if (dead) bs.splice(i, 1);
    }

    // ── grenades fly their arc; on the deck (or fuse-out) they answer the crowd
    const nds = nades.current;
    for (let i = nds.length - 1; i >= 0; i--) {
      const n = nds[i];
      n.vy -= 22 * dt;
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.z += n.vz * dt;
      if (n.y <= 0.14 || now - n.bornAt > GRENADE_FUSE_MS) {
        nds.splice(i, 1);
        worldSfx.boom();
        arcadeFx.explode(n.x, Math.max(0.6, n.y), n.z);
        arcadeShake.add(Math.max(0.15, 0.5 - Math.hypot(p.x - n.x, p.z - n.z) * 0.04));
        s.freezeUntil = Math.max(s.freezeUntil, now + 55);
        for (const z of zombies.current) {
          if (!z.alive) continue;
          if (Math.hypot(z.x - n.x, z.z - n.z) < GRENADE_BLAST_R) {
            z.hp -= GRENADE_DMG;
            if (z.hp <= 0) killZombie(z, true);
            else {
              worldSfx.zombieHit();
              zAnims.current[zombies.current.indexOf(z)].hitAt = now;
            }
          }
        }
        // your own blast bites if you hug it — throw it AWAY from your feet
        if (Math.hypot(p.x - n.x, p.z - n.z) < GRENADE_SELF_R && (p.h ?? 0) < 2) {
          s.hp = Math.max(0, s.hp - GRENADE_SELF_DMG);
          s.hurtAt = now;
          s.combo = 0;
          worldSfx.hurt();
        }
      }
    }

    // ── zombies come — and at higher waves, they RUN (never faster than you).
    // Yuka steers the horde (seek + separation + wander → they fan out and
    // flank instead of stacking); our colliders then clamp every proposed
    // position, exactly as before. Same speeds, same bite, better crowd.
    // hit-stop freezes the horde for a few frames on the heaviest impacts; the
    // boss's entrance runs them at a third speed for its beat of slow-mo
    const frozen = now < s.freezeUntil;
    const timeK = now < s.bossSlowUntil ? 0.35 : 1;
    const speedBase = zombieSpeed(s.wave);
    ZOMBIE_GAIT.speed = speedBase * timeK; // every figure picks its gait off this — slow-mo reads in the animation too
    yk.targetVec.set(p.x, 0, p.z);
    if (!frozen) {
    zombies.current.forEach((z, i) => {
      const v = yk.vehicles[i];
      v.active = z.alive;
      if (!z.alive) return;
      // per-kind pace: runners close, crawlers creep, exploders waddle
      const mul = z.boss ? 1 : ZOMBIE_KINDS[z.kind as ZombieKind].speedMul;
      v.maxSpeed = z.boss ? 2.0 : speedBase * (0.9 + Math.sin(z.seed) * 0.12) * mul;
      // the slot is the source of truth (knockback shoves land here) — sync in
      v.position.x = z.x;
      v.position.z = z.z;
      v.position.y = 0;
    });
    yk.em.update(dt * timeK);
    zombies.current.forEach((z, i) => {
      if (!z.alive) return;
      const v = yk.vehicles[i];
      v.position.y = 0;
      v.velocity.y = 0;
      // collide-clamp the vehicle's proposed position — colliders stay boss
      let [nx, nz] = resolvePlatXZ(ZOMBIE_PLATS, v.position.x, v.position.z, 0);
      const dcx = nx - f.cx, dcz = nz - f.cz;
      const rad = Math.hypot(dcx, dcz);
      if (rad > f.r + 8) { nx = f.cx + (dcx / rad) * (f.r + 8); nz = f.cz + (dcz / rad) * (f.r + 8); }
      z.x = nx; z.z = nz;
      v.position.x = nx;
      v.position.z = nz;
      const toP = Math.hypot(p.x - z.x, p.z - z.z);
      // the exploder doesn't bite — it IS the bite
      if (z.kind === "exploder" && toP < EXPLODER_FUSE_DIST && (p.h ?? 0) < 2.3) {
        killZombie(z, false); // no bounty for one that took itself out on you
        return;
      }
      // the bite — with the LUNGE the figure animates. Reach-up: a low wall or
      // crypt roof is COVER, not a safehouse — anything but a crawler drags you
      // off a perch, and the boss reaches higher still. Camping is dead.
      const reach = z.boss ? 2.2 : z.kind === "crawler" ? 1.3 : 1.5;
      const reachH = z.boss ? 2.7 : z.kind === "crawler" ? 1.2 : 2.3;
      if (toP < reach && now >= z.hitCooldownUntil && (p.h ?? 0) < reachH) {
        z.hitCooldownUntil = now + 950;
        zAnims.current[i].attackAt = now;
        const bite = z.boss ? 22 : ZOMBIE_KINDS[z.kind as ZombieKind].bite;
        if (bite > 0) {
          s.hp = Math.max(0, s.hp - bite);
          s.hurtAt = now;
          s.combo = 0; // one bite wipes the streak — that's the tension
          arcadeShake.add(z.boss ? 0.4 : 0.28);
          worldSfx.hurt();
        }
      }
    });
    } // end !frozen — the horde stands still through a hit-stop

    // ── kill drops: walk over one before it fades
    for (let i = drops.current.length - 1; i >= 0; i--) {
      const d = drops.current[i];
      if (now - d.at > DROP_DESPAWN_MS) { drops.current.splice(i, 1); continue; }
      if (Math.hypot(p.x - d.x, p.z - d.z) < 1.4 && (p.h ?? 0) < 0.8) {
        if (d.kind === "max_ammo") { s.mag = s.weapon.magSize; s.magsLeft = s.weapon.mags; s.grenades = GRENADES_START; s.boxMsg = "MAX AMMO"; }
        else if (d.kind === "insta_kill") { s.instaUntil = now + INSTA_KILL_MS; s.boxMsg = "INSTA-KILL"; }
        else { s.hp = s.maxHp; s.boxMsg = "FULL HEALTH"; }
        s.boxMsgUntil = now + 2000;
        worldSfx.pick();
        drops.current.splice(i, 1);
      }
    }

    // ── the Mystery Box ritual advances on its own clock
    if (s.boxState === "spinning" && now - s.boxSpinStart > 2400) {
      const pool = BOX_POOL.filter((id) => id !== s.weapon.id);
      s.boxOffer = WEAPONS[pool[Math.floor(Math.random() * pool.length)] ?? BOX_POOL[0]];
      s.boxState = "offering";
      s.boxOfferUntil = now + BOX_OFFER_MS;
    }
    if (s.boxState === "offering") {
      if (now > s.boxOfferUntil) { // stays the full BOX_OFFER_MS — no walk-away snatch
        s.boxState = "idle";
        s.boxOffer = null;
        s.boxMsg = `Kept your ${s.weapon.name.toUpperCase()}`;
        s.boxMsgUntil = now + 1600;
      }
    }

    // ── you fell
    if (s.hp <= 0) {
      s.done = true;
      // no frozen props behind the recap: live grenades vanish with the run
      nades.current.length = 0;
      nadeRefs.current.forEach((el) => { if (el) el.visible = false; });
      onEnd(s.wave, { kills: s.kills, points: s.points, shots: s.shots, hits: s.hitsTally, crits: s.crits });
    }

    // ── render: zombies (corpses keep their slot while the fall plays), bolts, pickups
    zombies.current.forEach((z, i) => {
      const el = zRefs.current[i];
      if (!el) return;
      el.visible = z.alive || (z.dieAt > 0 && now - z.dieAt < 700);
      if (z.alive) {
        el.position.set(z.x, Math.abs(Math.sin(t * 4 + z.seed)) * 0.02, z.z);
        el.rotation.y = Math.atan2(p.x - z.x, p.z - z.z);
      }
    });
    const im = boltMesh.current;
    if (im) {
      for (let i = 0; i < 24; i++) {
        const b = bs[i];
        if (b) {
          BOLT_DIR.set(b.dx, b.dy, b.dz).normalize();
          BOLT_Q.setFromUnitVectors(BOLT_UP, BOLT_DIR); // cylinder axis (Y) → travel direction
          BOLT_POS.set(b.x, b.y, b.z);
          m4.current.compose(BOLT_POS, BOLT_Q, BOLT_SCL);
        } else {
          m4.current.makeTranslation(0, -40, 0);
        }
        im.setMatrixAt(i, m4.current);
      }
      im.instanceMatrix.needsUpdate = true;
    }
    // blood: a burst of droplets arcing out and falling, gone in ~400ms
    splatRefs.current.forEach((el, i) => {
      if (!el) return;
      const sp = splats.current[i];
      const age = sp ? now - sp.at : 9999;
      if (!sp || age > 400) { el.visible = false; return; }
      el.visible = true;
      el.position.set(sp.x, 0, sp.z);
      const k = age / 400;
      el.children.forEach((c, j) => {
        const d = DROP_DIRS[j % DROP_DIRS.length];
        c.position.set(d[0] * k * 1.1, 1.05 + 0.55 * k - 1.7 * k * k + d[2] * 0.1, d[1] * k * 1.1);
        c.scale.setScalar(1 - k * 0.55);
      });
    });
    // grenades in flight: tumbling spheres riding their computed arc
    nadeRefs.current.forEach((el, i) => {
      if (!el) return;
      const n = nades.current[i];
      if (!n) { el.visible = false; return; }
      el.visible = true;
      el.position.set(n.x, n.y, n.z);
      el.rotation.x = t * 9;
      el.rotation.z = t * 7;
    });
    // drops: show each slot at its drop, spin, blink near despawn
    dropRefs.current.forEach((el, i) => {
      if (!el) return;
      const d = drops.current[i];
      if (!d) { el.visible = false; return; }
      const age = now - d.at;
      el.visible = age < DROP_DESPAWN_MS - 1500 || Math.floor(t * 6) % 2 === 0; // blink at the end
      el.position.set(d.x, 0.75 + Math.sin(t * 3 + i) * 0.12, d.z);
      el.rotation.y = t * 2.2;
      // kind child visibility: 0=max_ammo 1=insta_kill 2=health
      el.children.forEach((c, j) => { c.visible = DROP_KINDS[j] === d.kind; });
    });

    // ── the Mystery Box: proximity, lid, and the weapon carousel
    s.nearBox = Math.hypot(p.x - MYSTERY_BOX.x, p.z - MYSTERY_BOX.z) < 2.6 && (p.h ?? 0) < 1;
    const boxEl = boxRef.current;
    if (boxEl) {
      // the box sits still; only its light breathes when idle
      boxEl.position.y = 0.55;
      boxEl.rotation.y = 0;
    }
    const lid = boxLidRef.current;
    if (lid) {
      // lid swings open while spinning/offering, closes when idle
      const target = s.boxState === "idle" ? 0 : -1.9;
      lid.rotation.x += (target - lid.rotation.x) * 0.12;
    }
    // the beam glows whenever the lid is open
    const beam = boxBeamRef.current;
    if (beam) {
      beam.visible = s.boxState !== "idle";
      beam.rotation.y = t * 0.6;
    }
    // weapon carousel above the box: cycles fast while spinning, locks on the offer
    const showIdx =
      s.boxState === "spinning" ? Math.floor((now - s.boxSpinStart) / 160) % BOX_POOL.length
      : s.boxState === "offering" && s.boxOffer ? BOX_POOL.indexOf(s.boxOffer.id)
      : -1;
    boxWeaponRefs.current.forEach((el, i) => {
      if (!el) return;
      el.visible = i === showIdx;
      if (i === showIdx) {
        el.position.y = 2.6 + Math.sin(t * 2.5) * 0.1;
        el.rotation.y = s.boxState === "spinning" ? t * 9 : t * 1.2;
      }
    });

    // ── streak expiry: the window closed with no kill — the combo chip clears
    if (s.combo > 0 && now - s.comboAt > COMBO_WINDOW_MS) s.combo = 0;

    // ── low-HP tension: under a quarter tank the heart pounds and the music
    // ducks under it — recover and everything swells back
    if (s.hp > 0 && s.hp <= s.maxHp * 0.25) {
      if (now >= s.nextHeartbeatAt) {
        s.nextHeartbeatAt = now + 900;
        worldSfx.heartbeat();
      }
      zombieMusic.setDuck(0.45);
    } else {
      zombieMusic.setDuck(1);
    }

    // ── HUD (only on change)
    const breather = s.breatherUntil > now;
    // the soundtrack tracks the fight: waves add layers, breathers thin the beat
    zombieMusic.setState(s.wave, breather);
    // the live boss, if one's up — its health bar has an arc to follow
    let bossFrac: number | null = null;
    for (const z of zombies.current) {
      if (z.alive && z.boss) {
        bossFrac = Math.max(0, Math.min(1, z.hp / s.bossMaxHp));
        break;
      }
    }
    const boxMsg = s.boxMsgUntil > now ? s.boxMsg : null;
    // interaction prompts, nearest-first: the box, then wall-buys, then the perk
    const nearBuy = ZOMBIE_WALLBUYS.find((wb) => Math.hypot(p.x - wb.x, p.z - wb.z) < 2.6);
    const nearPerk = !s.perkOwned && Math.hypot(p.x - ZOMBIE_PERK.x, p.z - ZOMBIE_PERK.z) < 2.6;
    const nearPerk2 = !s.perk2Owned && Math.hypot(p.x - ZOMBIE_PERK2.x, p.z - ZOMBIE_PERK2.z) < 2.6;
    const boxPrompt = s.nearBox
      ? s.boxState === "spinning"
        ? "…"
        : s.boxState === "offering" && s.boxOffer
          ? `E — take the ${s.boxOffer.name.toUpperCase()} · walk away to keep your ${s.weapon.name.toUpperCase()}`
          : s.points >= MYSTERY_BOX.cost
            ? `E — open the Mystery Box (${MYSTERY_BOX.cost} pts)`
            : `Mystery Box needs ${MYSTERY_BOX.cost} pts — you have ${s.points}`
      : nearBuy
        ? s.points >= nearBuy.cost
          ? `E — buy the ${WEAPONS[nearBuy.weapon].name.toUpperCase()} (${nearBuy.cost} pts)`
          : `${WEAPONS[nearBuy.weapon].name.toUpperCase()} costs ${nearBuy.cost} pts — you have ${s.points}`
        : nearPerk
          ? s.points >= ZOMBIE_PERK.cost
            ? `E — VIGOR: +50 max HP (${ZOMBIE_PERK.cost} pts)`
            : `VIGOR costs ${ZOMBIE_PERK.cost} pts — you have ${s.points}`
          : nearPerk2
            ? s.points >= ZOMBIE_PERK2.cost
              ? `E — QUICK HANDS: reload ~2× faster (${ZOMBIE_PERK2.cost} pts)`
              : `QUICK HANDS costs ${ZOMBIE_PERK2.cost} pts — you have ${s.points}`
            : null;
    const power = s.instaUntil > now ? "INSTA-KILL" : null;
    const reloading = s.reloadUntil > now;
    const banner = s.bannerUntil > now ? s.banner : null;
    const breatherLeft = s.breatherUntil > now ? Math.ceil((s.breatherUntil - now) / 1000) : 0;
    // the HUD's hp is a PERCENT of max — the VIGOR perk widens the tank, the bar
    // stays honest
    const hpPct = Math.round((s.hp / s.maxHp) * 100);
    const hud = lastHud.current;
    if (
      hud.hp !== hpPct || hud.mag !== s.mag || hud.magsLeft !== s.magsLeft || hud.reloading !== reloading ||
      hud.zoomed !== wantZoom || hud.kills !== s.kills || hud.wave !== s.wave ||
      hud.breather !== breather || hud.breatherLeft !== breatherLeft || hud.banner !== banner ||
      hud.hurtAt !== s.hurtAt || hud.hitAt !== s.hitAt || hud.killAt !== s.killAt || hud.critAt !== s.critAt || hud.popupAt !== s.popupAt ||
      hud.points !== s.points ||
      hud.weapon !== s.weapon.name || hud.boxPrompt !== boxPrompt || hud.boxMsg !== boxMsg || hud.power !== power ||
      hud.combo !== s.combo || hud.comboAt !== s.comboAt || hud.boss !== bossFrac || hud.bossAt !== s.bossAt ||
      hud.grenades !== s.grenades
    ) {
      lastHud.current = {
        hp: hpPct, kills: s.kills, wave: s.wave, breather, breatherLeft, banner, hurtAt: s.hurtAt,
        hitAt: s.hitAt, killAt: s.killAt, critAt: s.critAt, popupAmt: s.popupAmt, popupAt: s.popupAt,
        points: s.points, weapon: s.weapon.name, mag: s.mag, magsLeft: s.magsLeft, reloading, zoomed: wantZoom,
        boxPrompt, boxMsg, power,
        combo: s.combo, comboMult: comboMult(s.combo), comboAt: s.comboAt, boss: bossFrac, bossAt: s.bossAt,
        grenades: s.grenades,
      };
      onHud(lastHud.current);
    }
  });

  return (
    <group>
      {/* zombie pool */}
      {Array.from({ length: ZOMBIE_CAP }, (_, i) => (
        <group key={i} ref={(el) => { zRefs.current[i] = el; }} visible={false}>
          <ZombieFigure boss={i >= 20} seed={i * 1.37} idx={i} anims={zAnims} />
        </group>
      ))}
      {/* bolts */}
      <instancedMesh ref={boltMesh} args={[undefined, undefined, 24]} frustumCulled={false}>
        <cylinderGeometry args={[0.035, 0.035, 1.6, 6]} />
        <meshStandardMaterial color="#ffe9a8" emissive="#ffc85e" emissiveIntensity={2.6} toneMapped={false} transparent opacity={0.9} />
      </instancedMesh>
      {/* grenades — a pool of three tumbling shells */}
      {Array.from({ length: 3 }, (_, i) => (
        <group key={`nade${i}`} ref={(el) => { nadeRefs.current[i] = el; }} visible={false}>
          <mesh castShadow>
            <sphereGeometry args={[0.15, 8, 8]} />
            <meshStandardMaterial color="#2e3a2e" roughness={0.55} metalness={0.3} />
          </mesh>
          <mesh position={[0, 0.15, 0]}>
            <boxGeometry args={[0.07, 0.09, 0.07]} />
            <meshStandardMaterial color="#8a8f8a" metalness={0.5} roughness={0.4} />
          </mesh>
        </group>
      ))}
      {/* blood — droplet bursts */}
      {Array.from({ length: 10 }, (_, i) => (
        <group key={`bl${i}`} ref={(el) => { splatRefs.current[i] = el; }} visible={false}>
          {DROP_DIRS.map((_, j) => (
            <mesh key={j}>
              <sphereGeometry args={[0.085, 6, 6]} />
              <meshStandardMaterial color="#8a1414" roughness={0.6} />
            </mesh>
          ))}
        </group>
      ))}
      {/* the Mystery Box — pay to OPEN it: the lid swings up, weapons spin
          above it, and the offer hovers until you take it or walk away */}
      <group position={[MYSTERY_BOX.x, 0, MYSTERY_BOX.z]}>
        {/* wide stone dais with rune ring */}
        <mesh position={[0, 0.14, 0]}>
          <cylinderGeometry args={[1.9, 2.1, 0.28, 14]} />
          <meshStandardMaterial color="#4a4a55" roughness={0.8} />
        </mesh>
        <mesh position={[0, 0.29, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.35, 1.55, 28]} />
          <meshStandardMaterial color="#a78bfa" emissive="#8b5cf6" emissiveIntensity={0.9} toneMapped={false} transparent opacity={0.85} />
        </mesh>
        <group ref={boxRef} position={[0, 0.55, 0]}>
          {/* chest body — big, ornate */}
          <mesh position={[0, 0.15, 0]}>
            <boxGeometry args={[1.7, 0.95, 1.1]} />
            <meshStandardMaterial color="#3a2f4a" roughness={0.5} metalness={0.2} emissive="#6d28d9" emissiveIntensity={0.3} />
          </mesh>
          {/* gilt edges */}
          {[[-0.85, 0], [0.85, 0]].map(([dx], i) => (
            <mesh key={`e${i}`} position={[dx, 0.15, 0]}>
              <boxGeometry args={[0.1, 1.0, 1.16]} />
              <meshStandardMaterial color="#ffd76b" metalness={0.6} roughness={0.35} />
            </mesh>
          ))}
          {/* iron banding */}
          {[-0.45, 0.45].map((dx) => (
            <mesh key={dx} position={[dx, 0.15, 0]}>
              <boxGeometry args={[0.12, 1.02, 1.14]} />
              <meshStandardMaterial color="#2a2138" roughness={0.4} metalness={0.4} />
            </mesh>
          ))}
          {/* glowing rune on the front */}
          <mesh position={[0, 0.2, 0.57]}>
            <boxGeometry args={[0.3, 0.3, 0.02]} />
            <meshStandardMaterial color="#c4b5fd" emissive="#a78bfa" emissiveIntensity={1.6} toneMapped={false} />
          </mesh>
          {/* hinged lid — pivots at its back edge */}
          <group ref={boxLidRef} position={[0, 0.63, -0.55]}>
            <mesh position={[0, 0.13, 0.55]}>
              <boxGeometry args={[1.76, 0.26, 1.14]} />
              <meshStandardMaterial color="#2a2138" roughness={0.5} />
            </mesh>
            <mesh position={[0, 0.13, 1.08]}>
              <boxGeometry args={[0.24, 0.24, 0.1]} />
              <meshStandardMaterial color="#ffd76b" emissive="#ffb84a" emissiveIntensity={0.8} toneMapped={false} />
            </mesh>
            {/* lid gilt rim */}
            <mesh position={[0, 0.27, 0.55]}>
              <boxGeometry args={[1.8, 0.06, 1.18]} />
              <meshStandardMaterial color="#ffd76b" metalness={0.6} roughness={0.35} />
            </mesh>
          </group>
          {/* the reveal beam — a glowing column while the box is open */}
          <mesh ref={boxBeamRef} position={[0, 2.9, 0]} visible={false}>
            <cylinderGeometry args={[0.55, 1.05, 4.6, 14, 1, true]} />
            <meshStandardMaterial color="#c4b5fd" emissive="#a78bfa" emissiveIntensity={1.4} transparent opacity={0.32} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
          </mesh>
          {/* the weapon carousel — LIT and BIG so the roll reads from anywhere */}
          {BOX_POOL.map((id, i) => (
            <group key={id} ref={(el) => { boxWeaponRefs.current[i] = el; }} visible={false} position={[0, 2.6, 0]} scale={1.9}>
              <WeaponModel id={id} />
              <pointLight position={[0, 0.3, 0.4]} color="#e9d5ff" intensity={5} distance={4} />
            </group>
          ))}
        </group>
        <pointLight position={[0, 1.6, 0]} color="#a78bfa" intensity={4} distance={8} />
        <Label text={`MYSTERY BOX · ${MYSTERY_BOX.cost} PTS`} position={[0, 4.9, 0]} scale={1.9} color="#a78bfa" />
      </group>
      {/* the first-person viewmodel: the real model of whatever you're holding */}
      <group ref={gunRef} visible={false}>
        {WEAPON_IDS.map((id) => (
          <group key={id} ref={(el) => { vmRefs.current[id] = el; }} visible={id === "pistol"}>
            <WeaponModel id={id} />
          </group>
        ))}
        {/* the muzzle light — flashes on lastFire, decays in ~75ms (see useFrame) */}
        <pointLight ref={muzzleLight} position={[0, -0.12, -1.15]} color="#ffc985" intensity={0} distance={11} decay={2} />
      </group>
      {/* kill drops — a slot pool; the manager positions them and picks the icon */}
      {Array.from({ length: 6 }, (_, i) => (
        <group key={`drop${i}`} ref={(el) => { dropRefs.current[i] = el; }} visible={false}>
          {/* 0: MAX AMMO — an open ammo tin: lid thrown back, brass rows inside, a belt over the rim */}
          <group>
            <mesh position={[0, -0.12, 0]}><boxGeometry args={[0.54, 0.24, 0.36]} /><meshStandardMaterial color="#3f4a3a" roughness={0.55} metalness={0.35} /></mesh>
            <mesh position={[0, -0.02, -0.26]} rotation={[-2.2, 0, 0]}><boxGeometry args={[0.54, 0.03, 0.3]} /><meshStandardMaterial color="#37412f" roughness={0.6} metalness={0.3} /></mesh>
            <mesh position={[0, -0.1, 0.185]}><boxGeometry args={[0.22, 0.09, 0.015]} /><meshStandardMaterial color="#c9c4a8" roughness={0.8} /></mesh>
            {Array.from({ length: 8 }, (_, bi) => (
              <group key={bi} position={[-0.17 + (bi % 4) * 0.11, 0.06, bi < 4 ? -0.07 : 0.07]}>
                <mesh><cylinderGeometry args={[0.033, 0.033, 0.2, 8]} /><meshStandardMaterial color="#d9a13a" metalness={0.75} roughness={0.25} /></mesh>
                <mesh position={[0, 0.13, 0]}><cylinderGeometry args={[0.02, 0.033, 0.07, 8]} /><meshStandardMaterial color="#8a6a2a" metalness={0.7} roughness={0.3} /></mesh>
              </group>
            ))}
            {Array.from({ length: 5 }, (_, bi) => (
              <mesh key={`bt${bi}`} position={[0.29, 0.02 - bi * 0.065, 0.1 - bi * 0.02]} rotation={[Math.PI / 2, 0, 0.5 + bi * 0.16]}>
                <cylinderGeometry args={[0.03, 0.03, 0.17, 7]} />
                <meshStandardMaterial color="#c8952f" metalness={0.75} roughness={0.3} />
              </mesh>
            ))}
            <pointLight position={[0, 0.35, 0]} color="#ffd27a" intensity={0.9} distance={2.5} />
          </group>
          {/* 1: INSTA-KILL — the skull: domed cranium, brow, cheekbones, nasal cavity, hinged jaw, a crack */}
          <group scale={1.3}>
            <mesh position={[0, 0.08, -0.02]} scale={[1, 0.96, 1.08]}><sphereGeometry args={[0.24, 14, 12]} /><meshStandardMaterial color="#e8e3d6" roughness={0.8} /></mesh>
            {/* brow ridge over the sockets */}
            <mesh position={[0, 0.05, 0.19]}><boxGeometry args={[0.34, 0.07, 0.1]} /><meshStandardMaterial color="#e0dbcc" roughness={0.85} /></mesh>
            {/* cheekbones */}
            {[-0.12, 0.12].map((dx) => (
              <mesh key={`cb${dx}`} position={[dx, -0.06, 0.15]}><boxGeometry args={[0.1, 0.07, 0.13]} /><meshStandardMaterial color="#dcd6c6" roughness={0.9} /></mesh>
            ))}
            {/* deep sockets + the red burn inside */}
            {[-0.09, 0.09].map((dx) => (
              <mesh key={`so${dx}`} position={[dx, 0.0, 0.2]}><sphereGeometry args={[0.062, 8, 8]} /><meshStandardMaterial color="#141210" roughness={1} /></mesh>
            ))}
            {[-0.09, 0.09].map((dx) => (
              <mesh key={`gl${dx}`} position={[dx, 0.0, 0.23]}><sphereGeometry args={[0.026, 6, 6]} /><meshStandardMaterial color="#ff2222" emissive="#ff2222" emissiveIntensity={2.6} toneMapped={false} /></mesh>
            ))}
            {/* nasal cavity */}
            <mesh position={[0, -0.07, 0.22]} rotation={[0.35, 0, 0]}><boxGeometry args={[0.045, 0.08, 0.04]} /><meshStandardMaterial color="#141210" roughness={1} /></mesh>
            {/* upper teeth row */}
            {[-0.08, -0.04, 0, 0.04, 0.08].map((dx) => (
              <mesh key={`ut${dx}`} position={[dx, -0.15, 0.17]}><boxGeometry args={[0.028, 0.05, 0.02]} /><meshStandardMaterial color="#f2eee2" roughness={0.8} /></mesh>
            ))}
            {/* the mandible — slightly ajar, hinge knobs at the jawline */}
            <mesh position={[0, -0.22, 0.05]} rotation={[0.18, 0, 0]}><boxGeometry args={[0.26, 0.09, 0.17]} /><meshStandardMaterial color="#dcd6c6" roughness={0.9} /></mesh>
            {[-0.14, 0.14].map((dx) => (
              <mesh key={`hj${dx}`} position={[dx, -0.14, 0.02]}><sphereGeometry args={[0.035, 6, 6]} /><meshStandardMaterial color="#d3cdbd" roughness={0.9} /></mesh>
            ))}
            {[-0.06, -0.02, 0.02, 0.06].map((dx) => (
              <mesh key={`lt${dx}`} position={[dx, -0.18, 0.15]} rotation={[0.18, 0, 0]}><boxGeometry args={[0.026, 0.04, 0.02]} /><meshStandardMaterial color="#efe9da" roughness={0.8} /></mesh>
            ))}
            {/* the crack across the crown */}
            <mesh position={[0.07, 0.22, 0.06]} rotation={[0.3, 0.4, 0.9]}><boxGeometry args={[0.2, 0.012, 0.012]} /><meshStandardMaterial color="#4a453c" roughness={1} /></mesh>
          </group>
          {/* 2: FULL HEALTH — a white medkit with the red cross */}
          <group>
            <mesh><boxGeometry args={[0.52, 0.34, 0.36]} /><meshStandardMaterial color="#f4f1ea" roughness={0.6} /></mesh>
            <mesh position={[0, 0.18, 0]}><boxGeometry args={[0.2, 0.05, 0.12]} /><meshStandardMaterial color="#c9c4b8" roughness={0.6} /></mesh>
            <mesh position={[0, 0.02, 0.185]}><boxGeometry args={[0.26, 0.08, 0.02]} /><meshStandardMaterial color="#e02020" emissive="#c01515" emissiveIntensity={0.5} toneMapped={false} /></mesh>
            <mesh position={[0, 0.02, 0.185]}><boxGeometry args={[0.08, 0.26, 0.02]} /><meshStandardMaterial color="#e02020" emissive="#c01515" emissiveIntensity={0.5} toneMapped={false} /></mesh>
          </group>
        </group>
      ))}
    </group>
  );
}

// ── The MINIGAMES overlay (DOM) ───────────────────────────────────────────────
export type GateState = "guest" | "checking" | "eligible" | "ineligible";

export interface OverlayBoards {
  [mode: string]: { week: { top: { player: string; ms: number }[] }; allTime: { top: { player: string; ms: number }[]; totalRuns: number } };
}

export function MinigamesOverlay({
  gate,
  required,
  onConnect,
  connecting,
  onPlay,
  onClose,
}: {
  gate: GateState;
  required: number;
  onConnect: () => void;
  connecting: boolean;
  onPlay: (mode: ArcadeModeId) => void;
  onClose: () => void;
}) {
  const canPlay = gate === "eligible";
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-center justify-center p-4">
        <div className="w-full max-w-3xl rounded-3xl bg-white/95 shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-2xl font-black text-gray-900 tracking-tight">🎮 Minigames</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Compete in the world&apos;s arenas — every finish posts to the weekly and all-time leaderboards.
          </p>

          {/* the gate — checked HERE, before you ever enter a mode */}
          {gate === "guest" && (
            <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm text-amber-800">
                Minigames need a Phantom sign-in — and the wallet must hold{" "}
                <span className="font-bold">{required.toLocaleString()} $AXON</span> to play.
              </p>
              <button
                onClick={onConnect}
                disabled={connecting}
                className="rounded-full bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-sm font-bold px-4 py-2 shadow hover:brightness-110 disabled:opacity-70"
              >
                {connecting ? "Connecting…" : "Log in with Phantom"}
              </button>
            </div>
          )}
          {gate === "checking" && (
            <div className="mb-4 rounded-xl bg-gray-50 border border-gray-200 px-4 py-3">
              <p className="text-sm text-gray-600">Checking your $AXON balance on-chain…</p>
            </div>
          )}
          {gate === "ineligible" && (
            <div className="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
              <p className="text-sm text-red-700">
                🔒 You need to hold <span className="font-bold">{required.toLocaleString()} $AXON</span> in this wallet to
                play the minigames.
              </p>
            </div>
          )}
          {gate === "eligible" && (
            <div className="mb-4 rounded-xl bg-teal-50 border border-teal-200 px-4 py-3">
              <p className="text-sm text-teal-800">✓ Wallet verified — {required.toLocaleString()} $AXON held. Pick your game.</p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {MINIGAMES.map((m) => (
              <div key={m.id} className="rounded-2xl border border-gray-200 bg-white p-4 flex flex-col hover:border-teal-400 hover:shadow-md transition-all">
                <p className="text-3xl mb-1">{m.icon}</p>
                <h3 className="font-bold text-gray-900">{m.title}</h3>
                <p className="text-xs font-semibold text-teal-600 mb-1.5">{m.tagline}</p>
                <p className="text-xs text-gray-500 leading-relaxed flex-1">{m.description}</p>
                <p className="text-[10px] text-gray-400 font-mono mt-2 mb-2">
                  ranked by {m.metric === "time" ? "fastest time" : "highest wave"} · weekly + all-time
                </p>
                <button
                  onClick={() => canPlay && onPlay(m.id)}
                  disabled={!canPlay}
                  className={`rounded-xl text-sm font-bold py-2.5 transition ${
                    canPlay
                      ? "bg-teal-600 hover:bg-teal-700 text-white shadow"
                      : "bg-gray-100 text-gray-400 cursor-not-allowed"
                  }`}
                >
                  {canPlay ? "PLAY" : "🔒 PLAY"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
