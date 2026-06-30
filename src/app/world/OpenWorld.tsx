"use client";

// Phase 10: the walkable OPEN WORLD (distinct from the home-page island).
//
// Built straight from /api/world — every registered agent is a cottage placed at
// its deterministic district coordinates, so the world is genuinely large: you
// walk down dirt paths between districts, reading name signs to find an agent.
// Districts share a roof colour and carry a signpost. Publishes collision solids
// + interactable buildings (keyed by agentId) to the walking controller.

import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Rock, LAMP_BULB_MAT, LampGlowDriver, Sheep, Cow, Bench, Barrel, HayBale, MarketStall, Cloud, Smoke, Butterfly, Chicken, Bird, Flowers, GrassTuft, Barn, Windmill, VeggieGarden, Cart, shade, lighten } from "./decor";
import type { Collider, WorldBuilding } from "./Landing";
import { RARITY_COLOR, type Rarity } from "./items";
import { nightFactor } from "./dayCycle";

type Vec3 = [number, number, number];

export interface OpenPlot {
  agentId: string;
  name: string;
  district: string;
  x: number;
  z: number;
  size: number;
  active: boolean;
  walletAddress: string | null;
  /** Raw reputation score — drives the Hall of Fame statues. */
  reputation?: number;
}
/** Landmark coordinates the world reports for the plaza map board. */
export interface WorldLandmarks {
  farm: { x: number; z: number } | null;
  hof: { x: number; z: number } | null;
  garden: { x: number; z: number };
  ponds: { x: number; z: number }[];
  river: { x: number; z: number };
  /** The river's actual arc, for drawing it on maps. */
  riverArc: { r: number; a0: number; span: number };
  /** District street angles radiating from the plaza. */
  streets: number[];
  extent: number;
}
/** A weekly-top agent staffing a plaza market stall. */
export interface StallStaffAgent {
  agentId: string;
  name: string;
  price: string | null;
  tasks7d: number;
}
export interface OpenDistrict { name: string; centerX: number; centerZ: number }
// A dock-side spot where the fishing minigame can start: x/z = shore trigger,
// sx/sz = the on-dock stance for the cast, bx/bz = the bobber's water target.
export interface FishSpot { x: number; z: number; sx: number; sz: number; ry: number; bx: number; bz: number }
// A bench a visitor can sit on (ry = the direction a seated character faces).
export interface BenchSpot { x: number; z: number; ry: number }
// Somewhere you can gather — an orchard tree, a berry bush or a dig mound.
export interface GatherSpot { id: string; kind: "apple" | "berry" | "dig"; x: number; z: number }

// The farmstead's fenced paddock (farm-local coords) — one source of truth for
// both the fence render and the post colliders.
const PADDOCK = { cx: -2, cz: -8, w: 9, d: 6 };
function paddockPosts(): [number, number][] {
  const pts: [number, number][] = [];
  const { cx, cz, w, d } = PADDOCK;
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  for (let x = x0; x <= x1 + 0.01; x += w / 4) pts.push([x, z0], [x, z1]);
  for (let z = z0 + d / 3; z < z1 - 0.01; z += d / 3) pts.push([x0, z], [x1, z]);
  return pts;
}

const WALL = ["#f4ead6", "#efe0c6", "#f6e6d2", "#eae2d2", "#f7edda", "#e8dcc2"];
const DISTRICT_ROOFS = ["#c0563e", "#4a7c59", "#5b6f9e", "#c99a3a", "#8a5a86", "#3f8f8a", "#d98a4a", "#7a5c9e"];
// Every district paints its doors its own colour — neighbourhood identity.
const DOOR_COLS = ["#5b3a22", "#7a2e2a", "#2e4a6b", "#3e5a3a", "#6b4a7a", "#8a6a2a", "#a34d2e"];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Distance from a point to a line segment — used to keep trees off the paths.
function distToSeg(px: number, pz: number, x1: number, z1: number, x2: number, z2: number): number {
  const dx = x2 - x1, dz = z2 - z1;
  const l2 = dx * dx + dz * dz;
  if (l2 === 0) return Math.hypot(px - x1, pz - z1);
  let t = ((px - x1) * dx + (pz - z1) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz));
}

// Scratch objects reused when writing instance matrices (no per-frame allocs).
const _im = new THREE.Matrix4();
const _iq = new THREE.Quaternion();
const _iq2 = new THREE.Quaternion();
const _ie = new THREE.Euler();
const _ip = new THREE.Vector3();
const _is = new THREE.Vector3();
const _ic = new THREE.Color();

// Thousands of individual grass blades in a single draw call (instanced), in a
// few shades of green so the meadow reads textured instead of flat.
function GrassField({ spots }: { spots: { x: number; z: number; s: number; c: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const blades = useMemo(() => {
    const r = mulberry(0x67a55);
    const out: { x: number; z: number; ry: number; tilt: number; s: number; c: number }[] = [];
    for (const sp of spots) {
      for (let i = 0; i < 3; i++) {
        out.push({
          x: sp.x + (r() - 0.5) * 0.55,
          z: sp.z + (r() - 0.5) * 0.55,
          ry: r() * Math.PI,
          tilt: (r() - 0.5) * 0.45,
          s: sp.s * (0.72 + r() * 0.56),
          c: (sp.c + i) % 3,
        });
      }
    }
    return out;
  }, [spots]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const GREENS = ["#5cb061", "#54a659", "#68bb6d"];
    blades.forEach((b, i) => {
      _ie.set(b.tilt, b.ry, 0);
      _iq.setFromEuler(_ie);
      _im.compose(_ip.set(b.x, 0.24 * b.s, b.z), _iq, _is.set(b.s, b.s, b.s));
      mesh.setMatrixAt(i, _im);
      // Regional hue drift: broad warm/cool meadow zones instead of one green.
      const zone = 0.92 + 0.16 * (0.5 + 0.5 * Math.sin(b.x * 0.021 + b.z * 0.017));
      mesh.setColorAt(i, _ic.set(GREENS[b.c]).multiplyScalar(zone));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [blades]);
  if (blades.length === 0) return null;
  return (
    <instancedMesh key={blades.length} ref={ref} args={[undefined, undefined, blades.length]} frustumCulled={false}>
      <coneGeometry args={[0.045, 0.5, 4]} />
      <meshStandardMaterial roughness={1} />
    </instancedMesh>
  );
}

// Meadow flowers — instanced stems + instanced colourful heads (2 draw calls).
function FlowerField({ spots }: { spots: { x: number; z: number }[] }) {
  const stemRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const flowers = useMemo(() => {
    const r = mulberry(0xf10e7);
    const out: { x: number; z: number; s: number; c: number }[] = [];
    for (const sp of spots) {
      const n = 3 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2, d = r() * 1.4;
        out.push({ x: sp.x + Math.cos(a) * d, z: sp.z + Math.sin(a) * d, s: 0.75 + r() * 0.5, c: Math.floor(r() * 6) });
      }
    }
    return out;
  }, [spots]);
  const petalRef = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const stems = stemRef.current, heads = headRef.current, petals = petalRef.current;
    if (!stems || !heads || !petals) return;
    const COLORS = ["#f472b6", "#fbbf24", "#f87171", "#c084fc", "#ffffff", "#fb7185"];
    _iq.identity();
    flowers.forEach((f, i) => {
      _im.compose(_ip.set(f.x, 0.2 * f.s, f.z), _iq, _is.set(f.s, f.s, f.s));
      stems.setMatrixAt(i, _im);
      // golden centre, petal disc around it — reads as a real bloom, not a dot
      _im.compose(_ip.set(f.x, 0.45 * f.s, f.z), _iq, _is.set(f.s * 0.55, f.s * 0.55, f.s * 0.55));
      heads.setMatrixAt(i, _im);
      heads.setColorAt(i, _ic.set("#f5cf4a"));
      _im.compose(_ip.set(f.x, 0.43 * f.s, f.z), _iq, _is.set(f.s * 1.7, f.s * 0.42, f.s * 1.7));
      petals.setMatrixAt(i, _im);
      petals.setColorAt(i, _ic.set(COLORS[f.c]));
    });
    stems.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    petals.instanceMatrix.needsUpdate = true;
    if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
    if (petals.instanceColor) petals.instanceColor.needsUpdate = true;
  }, [flowers]);
  if (flowers.length === 0) return null;
  return (
    <group>
      <instancedMesh key={`s${flowers.length}`} ref={stemRef} args={[undefined, undefined, flowers.length]} frustumCulled={false}>
        <cylinderGeometry args={[0.03, 0.035, 0.4, 5]} />
        <meshStandardMaterial color="#3f8f4a" roughness={1} />
      </instancedMesh>
      <instancedMesh key={`h${flowers.length}`} ref={headRef} args={[undefined, undefined, flowers.length]} frustumCulled={false}>
        <sphereGeometry args={[0.1, 8, 8]} />
        <meshStandardMaterial roughness={0.7} />
      </instancedMesh>
      <instancedMesh key={`p${flowers.length}`} ref={petalRef} args={[undefined, undefined, flowers.length]} frustumCulled={false}>
        <sphereGeometry args={[0.1, 8, 8]} />
        <meshStandardMaterial roughness={0.75} />
      </instancedMesh>
    </group>
  );
}

// Worn flagstones embedded down the middle of every trail (1 draw call).
function Flagstones({ stones }: { stones: { x: number; z: number; s: number; rot: number; c: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const TONES = ["#c3ab84", "#b7a07c", "#ccb48d"];
    stones.forEach((st, i) => {
      _ie.set(0, st.rot, 0);
      _iq.setFromEuler(_ie);
      _im.compose(_ip.set(st.x, 0.033, st.z), _iq, _is.set(st.s, 0.05, st.s * 0.78));
      mesh.setMatrixAt(i, _im);
      mesh.setColorAt(i, _ic.set(TONES[st.c % 3]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [stones]);
  if (stones.length === 0) return null;
  return (
    <instancedMesh key={stones.length} ref={ref} args={[undefined, undefined, stones.length]} frustumCulled={false} receiveShadow renderOrder={2.2}>
      <cylinderGeometry args={[0.5, 0.5, 1, 7]} />
      <meshStandardMaterial roughness={1} />
    </instancedMesh>
  );
}

// Fallen-leaf carpets under the blossom + autumn trees (1 draw call).
function LeafPatches({ patches }: { patches: { x: number; z: number; r: number; c: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const TONES = ["#e9b7cb", "#dd9b52"]; // blossom pink / autumn orange
    patches.forEach((p, i) => {
      _ie.set(-Math.PI / 2, 0, 0);
      _iq.setFromEuler(_ie);
      _im.compose(_ip.set(p.x, 0.006 + (i % 6) * 0.0016, p.z), _iq, _is.set(p.r, p.r, 1));
      mesh.setMatrixAt(i, _im);
      mesh.setColorAt(i, _ic.set(TONES[p.c % 2]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [patches]);
  if (patches.length === 0) return null;
  return (
    <instancedMesh key={patches.length} ref={ref} args={[undefined, undefined, patches.length]} frustumCulled={false}>
      <circleGeometry args={[1, 10]} />
      <meshStandardMaterial roughness={1} transparent opacity={0.85} />
    </instancedMesh>
  );
}

// Sunlit pollen motes drifting over the meadows — one instanced mesh, animated.
function Pollen({ extent }: { extent: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const motes = useMemo(() => {
    const r = mulberry(0xbee5);
    return Array.from({ length: 48 }, () => {
      const a = r() * Math.PI * 2;
      const rad = PLAZA_R + 4 + r() * Math.max(10, extent - PLAZA_R - 8);
      return { x: Math.cos(a) * rad, z: Math.sin(a) * rad, y: 0.7 + r() * 1.8, fx: 0.2 + r() * 0.5, fy: 0.4 + r() * 0.7, ph: r() * Math.PI * 2, amp: 1.2 + r() * 2.2 };
    });
  }, [extent]);
  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime;
    _iq.identity();
    _is.set(1, 1, 1);
    motes.forEach((mo, i) => {
      _ip.set(
        mo.x + Math.sin(t * mo.fx + mo.ph) * mo.amp,
        mo.y + Math.sin(t * mo.fy + mo.ph) * 0.5,
        mo.z + Math.cos(t * mo.fx * 0.8 + mo.ph) * mo.amp,
      );
      _im.compose(_ip, _iq, _is);
      mesh.setMatrixAt(i, _im);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, motes.length]} frustumCulled={false}>
      <sphereGeometry args={[0.05, 6, 6]} />
      <meshBasicMaterial color="#fff6c8" transparent opacity={0.65} toneMapped={false} />
    </instancedMesh>
  );
}

// Puffy clouds sliding slowly across the sky, wrapping at the horizon.
function DriftingClouds({ extent }: { extent: number }) {
  const g = useRef<THREE.Group>(null);
  const clouds = useMemo(() => {
    const r = mulberry(0xc10d5);
    return Array.from({ length: 7 }, () => ({
      x: (r() - 0.5) * 2 * (extent + 60),
      z: (r() - 0.5) * 2 * (extent + 40),
      y: 34 + r() * 18,
      s: 1.6 + r() * 2.6,
      v: 0.6 + r() * 0.9,
    }));
  }, [extent]);
  useFrame((_, rawDt) => {
    if (!g.current) return;
    const dt = Math.min(rawDt, 0.05);
    const wrap = extent + 90;
    g.current.children.forEach((c, i) => {
      c.position.x += dt * clouds[i].v;
      if (c.position.x > wrap) c.position.x = -wrap;
    });
  });
  return (
    <group ref={g}>
      {clouds.map((c, i) => (
        <Cloud key={i} position={[c.x, c.y, c.z]} scale={c.s} />
      ))}
    </group>
  );
}

// A few birds circling high over the world.
function SkyBirds({ extent }: { extent: number }) {
  const g = useRef<THREE.Group>(null);
  const routes = useMemo(() => {
    const r = mulberry(0xb12d);
    return Array.from({ length: 3 }, (_, i) => ({
      cx: (r() - 0.5) * extent * 0.9,
      cz: (r() - 0.5) * extent * 0.9,
      rad: 18 + r() * 26,
      y: 17 + i * 4 + r() * 3,
      w: (0.1 + r() * 0.08) * (i % 2 ? -1 : 1),
      ph: r() * Math.PI * 2,
    }));
  }, [extent]);
  useFrame((state) => {
    if (!g.current) return;
    const t = state.clock.elapsedTime;
    g.current.children.forEach((b, i) => {
      const rt = routes[i];
      const a = t * rt.w + rt.ph;
      b.position.set(rt.cx + Math.cos(a) * rt.rad, rt.y + Math.sin(t * 0.7 + rt.ph) * 1.2, rt.cz + Math.sin(a) * rt.rad);
      const sgn = rt.w >= 0 ? 1 : -1;
      b.rotation.y = Math.atan2(-Math.cos(a) * sgn, -Math.sin(a) * sgn);
    });
  });
  return (
    <group ref={g}>
      {routes.map((_, i) => (
        <group key={i}>
          <Bird color={i === 1 ? "#6a5a4a" : "#4a4a55"} />
        </group>
      ))}
    </group>
  );
}

// Butterflies fluttering over the flower patches.
function Butterflies({ spots }: { spots: { x: number; z: number }[] }) {
  const g = useRef<THREE.Group>(null);
  const flights = useMemo(() => {
    const r = mulberry(0xbf1e5);
    const centers = spots.length ? spots : [{ x: 0, z: 0 }];
    return Array.from({ length: Math.min(8, Math.max(3, centers.length)) }, (_, i) => {
      const c = centers[Math.floor(r() * centers.length)];
      return {
        cx: c.x, cz: c.z,
        rx: 1.5 + r() * 2.5, rz: 1.5 + r() * 2.5,
        fx: 0.25 + r() * 0.3, fz: 0.2 + r() * 0.3,
        ph: r() * Math.PI * 2,
        col: ["#f4a6c0", "#fbbf24", "#93c5fd", "#f87171"][i % 4],
      };
    });
  }, [spots]);
  useFrame((state) => {
    if (!g.current) return;
    const t = state.clock.elapsedTime;
    g.current.children.forEach((b, i) => {
      const f = flights[i];
      b.position.set(
        f.cx + Math.sin(t * f.fx + f.ph) * f.rx * 2,
        0.9 + Math.sin(t * 1.9 + f.ph) * 0.35,
        f.cz + Math.cos(t * f.fz + f.ph) * f.rz * 2,
      );
      b.rotation.y = t * 0.4 + f.ph;
      const wings = b.children[0]?.children;
      if (wings && wings.length >= 2) {
        const flap = 0.15 + Math.abs(Math.sin(t * 11 + f.ph)) * 0.85;
        wings[0].rotation.z = flap;
        wings[1].rotation.z = -flap;
      }
    });
  });
  return (
    <group ref={g}>
      {flights.map((f, i) => (
        <group key={i}>
          <Butterfly color={f.col} />
        </group>
      ))}
    </group>
  );
}

// A camera-facing signboard on a post — the thing you read to navigate.
function Signboard({ text, position, scale = 2.6, big = false }: { text: string; position: Vec3; scale?: number; big?: boolean }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = big ? "#3f2d1a" : "rgba(60,42,26,0.95)";
    const x = 4, y = 4, w = 248, h = 56, r = 12;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.fill();
    ctx.strokeStyle = "#caa46a";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#f4e6c8";
    ctx.font = `${big ? "bold 30px" : "600 26px"} system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let t = text;
    while (ctx.measureText(t).width > 226 && t.length > 1) t = t.slice(0, -1);
    if (t !== text) t = t.slice(0, -1) + "…";
    ctx.fillText(t, 128, 34);
    const texture = new THREE.CanvasTexture(c);
    texture.needsUpdate = true;
    return texture;
  }, [text, big]);
  return (
    <sprite position={position} scale={[scale, scale * 0.25, 1]}>
      <spriteMaterial map={tex} transparent />
    </sprite>
  );
}

// A wooden post under a district signboard.
function Signpost({ text, position }: { text: string; position: Vec3 }) {
  return (
    <group position={position}>
      <mesh position={[0, 1.4, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.14, 2.8, 8]} />
        <meshStandardMaterial color="#7a4a24" roughness={0.9} />
      </mesh>
      <Signboard text={text} position={[0, 3.2, 0]} scale={4.5} big />
    </group>
  );
}

// A clean, consistent cottage for the open world — proportioned roof (tied to
// wall height, not width), stone base, framed door + windows with flower boxes,
// and an optional chimney. Kept uniform so the districts read as tidy streets.
// The front door, hung on its left-edge hinge. Swings open smoothly when a
// knock answers — the per-frame lerp early-returns at rest, so 60+ houses'
// doors cost nothing while nobody is knocking.
function HingedDoor({ open, w, y, z, color = "#5b3a22" }: { open: boolean; w: number; y: number; z: number; color?: string }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, rawDt) => {
    const grp = g.current;
    if (!grp) return;
    const target = open ? -1.92 : 0;
    const cur = grp.rotation.y;
    if (Math.abs(cur - target) < 0.002) return;
    grp.rotation.y = cur + (target - cur) * Math.min(1, Math.min(rawDt, 0.05) * 7);
  });
  return (
    <group ref={g} position={[-w * 0.1, y, z]}>
      <mesh position={[w * 0.1, 0, 0]}>
        <boxGeometry args={[w * 0.2, 1.7, 0.1]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      {/* raised panels so the door reads carpentered, not painted-on */}
      <mesh position={[w * 0.1, 0.38, 0.055]}>
        <boxGeometry args={[w * 0.13, 0.62, 0.03]} />
        <meshStandardMaterial color={shade(color, 0.86)} roughness={0.9} />
      </mesh>
      <mesh position={[w * 0.1, -0.42, 0.055]}>
        <boxGeometry args={[w * 0.13, 0.58, 0.03]} />
        <meshStandardMaterial color={shade(color, 0.86)} roughness={0.9} />
      </mesh>
      {/* Brass knob rides the door */}
      <mesh position={[w * 0.16, -0.05, 0.07]}>
        <sphereGeometry args={[0.05, 8, 8]} />
        <meshStandardMaterial color="#d9b45a" metalness={0.4} roughness={0.5} />
      </mesh>
    </group>
  );
}

// Show children only when the player is within `range` — visibility flip per
// frame, no re-render. The near half of the house LOD.
function WithinRange({ x, z, range, playerRef, children }: { x: number; z: number; range: number; playerRef?: React.RefObject<{ x: number; z: number }>; children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const p = playerRef?.current;
    if (g.current && p) g.current.visible = Math.hypot(p.x - x, p.z - z) < range;
  });
  return <group ref={g}>{children}</group>;
}

// ALL houses as two instanced draw calls (walls + roofs). Instances within the
// near radius collapse to scale-0 so the full-detail house takes over — the
// swap is a throttled matrix update, not a React render.
function FarHouses({ houses, playerRef }: { houses: { key: string; pos: Vec3; rot: number; w: number; h: number; wall: string; roof: string; door?: string }[]; playerRef?: React.RefObject<{ x: number; z: number }> }) {
  const walls = useRef<THREE.InstancedMesh>(null);
  const roofs = useRef<THREE.InstancedMesh>(null);
  const doors = useRef<THREE.InstancedMesh>(null);
  const wins = useRef<THREE.InstancedMesh>(null);
  const nearState = useRef<boolean[]>([]);
  const frame = useRef(0);
  const setOne = (i: number, h: { pos: Vec3; rot: number; w: number; h: number }, hidden: boolean) => {
    const a = walls.current;
    const b = roofs.current;
    const d = doors.current;
    const wi = wins.current;
    if (!a || !b) return;
    const sc = hidden ? 0.0001 : 1;
    _ie.set(0, h.rot, 0);
    _iq.setFromEuler(_ie);
    _im.compose(_ip.set(h.pos[0], 0.18 + h.h / 2, h.pos[2]), _iq, _is.set(h.w * sc, h.h * sc, h.w * sc));
    a.setMatrixAt(i, _im);
    // door + two windows on the front face, so the far town never looks blank
    const df = h.w / 2 + 0.03;
    const fx = Math.sin(h.rot) * df;
    const fz = Math.cos(h.rot) * df;
    if (d) {
      _im.compose(_ip.set(h.pos[0] + fx, 0.18 + 0.85, h.pos[2] + fz), _iq, _is.set(h.w * 0.2 * sc, 1.7 * sc, 1));
      d.setMatrixAt(i, _im);
    }
    if (wi) {
      const winW = h.w * 0.22;
      for (let k = 0; k < 2; k++) {
        const lx = (k === 0 ? -1 : 1) * h.w * 0.26;
        const wx = h.pos[0] + lx * Math.cos(h.rot) + df * Math.sin(h.rot);
        const wz = h.pos[2] - lx * Math.sin(h.rot) + df * Math.cos(h.rot);
        _im.compose(_ip.set(wx, 0.18 + h.h * 0.55, wz), _iq, _is.set(winW * sc, winW * sc, 1));
        wi.setMatrixAt(i * 2 + k, _im);
      }
    }
    _ie.set(0, h.rot + Math.PI / 4, 0);
    _iq.setFromEuler(_ie);
    const roofH = h.h * 0.62;
    _im.compose(_ip.set(h.pos[0], 0.18 + h.h + roofH / 2, h.pos[2]), _iq, _is.set(h.w * 0.82 * sc, roofH * sc, h.w * 0.82 * sc));
    b.setMatrixAt(i, _im);
  };
  useLayoutEffect(() => {
    const a = walls.current;
    const b = roofs.current;
    if (!a || !b) return;
    nearState.current = houses.map(() => false);
    houses.forEach((h, i) => {
      setOne(i, h, false);
      a.setColorAt(i, _ic.set(h.wall));
      b.setColorAt(i, _ic.set(h.roof));
      if (doors.current) doors.current.setColorAt(i, _ic.set(h.door ?? "#5b3a22"));
    });
    a.instanceMatrix.needsUpdate = true;
    b.instanceMatrix.needsUpdate = true;
    if (a.instanceColor) a.instanceColor.needsUpdate = true;
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
    if (doors.current?.instanceColor) doors.current.instanceColor.needsUpdate = true;
     
  }, [houses]);
  useFrame(() => {
    frame.current++;
    if (frame.current % 6 !== 0) return; // threshold checks at 10Hz are plenty
    const p = playerRef?.current;
    const a = walls.current;
    const b = roofs.current;
    if (!p || !a || !b) return;
    let dirty = false;
    houses.forEach((h, i) => {
      const near = Math.hypot(p.x - h.pos[0], p.z - h.pos[2]) < 24;
      if (near !== nearState.current[i]) {
        nearState.current[i] = near;
        setOne(i, h, near);
        dirty = true;
      }
    });
    if (dirty) {
      a.instanceMatrix.needsUpdate = true;
      b.instanceMatrix.needsUpdate = true;
      if (doors.current) doors.current.instanceMatrix.needsUpdate = true;
      if (wins.current) wins.current.instanceMatrix.needsUpdate = true;
    }
  });
  if (houses.length === 0) return null;
  return (
    <group>
      <instancedMesh key={`fw${houses.length}`} ref={walls} args={[undefined, undefined, houses.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh key={`fr${houses.length}`} ref={roofs} args={[undefined, undefined, houses.length]} frustumCulled={false}>
        <coneGeometry args={[1, 1, 4]} />
        <meshStandardMaterial roughness={0.85} />
      </instancedMesh>
      <instancedMesh key={`fd${houses.length}`} ref={doors} args={[undefined, undefined, houses.length]} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh key={`fwn${houses.length}`} ref={wins} args={[undefined, undefined, houses.length * 2]} frustumCulled={false} material={WINDOW_MAT}>
        <planeGeometry args={[1, 1]} />
      </instancedMesh>
    </group>
  );
}

function AgentHouse({ w, h, wall, roof, rotation, chimney, active = false, detail = true, flair = 0, doorOpen = false, doorCol = "#5b3a22" }: { w: number; h: number; wall: string; roof: string; rotation: number; chimney: boolean; active?: boolean; detail?: boolean; flair?: number; doorOpen?: boolean; doorCol?: string }) {
  const roofH = h * 0.85;
  const base = 0.22;
  const df = w / 2 + 0.02;
  const winY = base + h * 0.6;
  const winW = w * 0.16;
  return (
    <group rotation={[0, rotation, 0]}>
      {/* Stone base */}
      <mesh position={[0, base / 2, 0]} receiveShadow castShadow>
        <boxGeometry args={[w + 0.3, base, w + 0.3]} />
        <meshStandardMaterial color="#9c968c" roughness={1} />
      </mesh>
      {/* Walls */}
      <mesh position={[0, base + h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, w]} />
        <meshStandardMaterial color={wall} roughness={0.92} />
      </mesh>
      {/* Corner timber framing — cottage look */}
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={`ct${i}`} position={[sx * (w / 2 - 0.02), base + h / 2, sz * (w / 2 - 0.02)]}>
          <boxGeometry args={[0.16, h, 0.16]} />
          <meshStandardMaterial color="#6b4a2a" roughness={0.95} />
        </mesh>
      ))}
      {/* Pyramid roof (moderate height, small overhang) + a lighter upper
          shingle tier so the roof reads layered instead of a flat cone */}
      <mesh position={[0, base + h + roofH / 2, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[w * 0.76, roofH, 4]} />
        <meshStandardMaterial color={roof} roughness={0.9} />
      </mesh>
      <mesh position={[0, base + h + roofH * 0.66, 0]} rotation={[0, Math.PI / 4, 0]}>
        <coneGeometry args={[w * 0.42, roofH * 0.5, 4]} />
        <meshStandardMaterial color={lighten(roof, 0.12)} roughness={0.9} />
      </mesh>
      {/* wall timber band at storey height */}
      <mesh position={[0, base + h * 0.52, 0]}>
        <boxGeometry args={[w + 0.06, 0.1, w + 0.06]} />
        <meshStandardMaterial color="#6b4a2a" roughness={0.95} />
      </mesh>
      {/* Eaves board under the roof edge + a ridge finial at the apex */}
      <mesh position={[0, base + h + 0.03, 0]}>
        <boxGeometry args={[w * 1.04, 0.12, w * 1.04]} />
        <meshStandardMaterial color={shade(roof, 0.72)} roughness={0.9} />
      </mesh>
      <mesh position={[0, base + h + roofH + 0.09, 0]}>
        <sphereGeometry args={[0.13, 8, 8]} />
        <meshStandardMaterial color={shade(roof, 0.66)} roughness={0.8} />
      </mesh>
      {detail && (
        <>
          {/* stone skirt grounding the house */}
          <mesh position={[0, 0.16, 0]} castShadow>
            <boxGeometry args={[w + 0.14, 0.32, w + 0.14]} />
            <meshStandardMaterial color="#9c968c" roughness={1} />
          </mesh>
          {/* roof ridge cap */}
          <mesh position={[0, base + h + h * 0.62 - 0.04, 0]}>
            <boxGeometry args={[0.24, 0.1, 0.24]} />
            <meshStandardMaterial color={shade(roof, 0.7)} roughness={0.85} />
          </mesh>
          {/* dormer on the front roof face */}
          <group position={[0, base + h + roofH * 0.32, w * 0.34]} rotation={[0, 0, 0]}>
            <mesh castShadow>
              <boxGeometry args={[0.8, 0.7, 0.6]} />
              <meshStandardMaterial color={wall} roughness={0.92} />
            </mesh>
            <mesh position={[0, 0.05, 0.31]} material={WINDOW_MAT}>
              <boxGeometry args={[0.42, 0.42, 0.04]} />
            </mesh>
            <mesh position={[0, 0.5, 0.05]} rotation={[0.5, 0, 0]}>
              <boxGeometry args={[0.92, 0.06, 0.8]} />
              <meshStandardMaterial color={shade(roof, 0.85)} roughness={0.9} />
            </mesh>
          </group>
          {/* porch lantern beside the door — a warm point of life */}
          <group position={[-(w * 0.1 + 0.35), base + 1.55, df + 0.06]}>
            <mesh>
              <boxGeometry args={[0.14, 0.2, 0.14]} />
              <meshStandardMaterial color="#ffd98a" emissive="#e8a94a" emissiveIntensity={active ? 0.8 : 0.25} roughness={0.5} />
            </mesh>
            <mesh position={[0, 0.14, 0]}>
              <coneGeometry args={[0.12, 0.1, 4]} />
              <meshStandardMaterial color="#3a332c" roughness={0.9} />
            </mesh>
          </group>
        </>
      )}
      {/* Door + pale frame. The door hangs on a hinge group (left edge) so a
          knock can swing it open; the dark plane behind reads as the doorway. */}
      {/* Real door frame — lintel + jambs with an actual OPENING (the old
          solid slab was what kept hiding the doorway interior). */}
      <mesh position={[0, base + 1.87, df]}>
        <boxGeometry args={[w * 0.2 + 0.14, 0.12, 0.08]} />
        <meshStandardMaterial color="#efe6d6" roughness={0.9} />
      </mesh>
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * (w * 0.1 + 0.035), base + 0.9, df]}>
          <boxGeometry args={[0.07, 1.94, 0.08]} />
          <meshStandardMaterial color="#efe6d6" roughness={0.9} />
        </mesh>
      ))}
      {doorOpen && (
        // A painted doorway interior — pre-shaded flat "room" (no lights, no
        // bloom): dark back wall, warm floor receding in perspective, a shelf
        // and chest silhouette. Reads as a room without costing one.
        <group position={[0, 0, df + 0.015]}>
          <mesh position={[0, base + 0.85, 0]}>
            <planeGeometry args={[w * 0.2, 1.7]} />
            <meshBasicMaterial color="#231708" />
          </mesh>
          {/* receding floor (bright at the threshold, darker inward) */}
          <mesh position={[0, base + 0.28, 0.004]}>
            <planeGeometry args={[w * 0.2, 0.56]} />
            <meshBasicMaterial color="#8a5f33" />
          </mesh>
          <mesh position={[0, base + 0.5, 0.005]}>
            <planeGeometry args={[w * 0.15, 0.16]} />
            <meshBasicMaterial color="#5e3f22" />
          </mesh>
          {/* warm lamp glow painted on the back wall, not a real light */}
          <mesh position={[w * 0.045, base + 1.05, 0.004]}>
            <circleGeometry args={[0.16, 12]} />
            <meshBasicMaterial color="#c98a3e" />
          </mesh>
          <mesh position={[w * 0.045, base + 1.05, 0.005]}>
            <circleGeometry args={[0.08, 10]} />
            <meshBasicMaterial color="#f0b45e" />
          </mesh>
          {/* shelf + chest silhouettes */}
          <mesh position={[-w * 0.05, base + 1.25, 0.004]}>
            <planeGeometry args={[w * 0.09, 0.05]} />
            <meshBasicMaterial color="#120b04" />
          </mesh>
          <mesh position={[-w * 0.05, base + 0.62, 0.004]}>
            <planeGeometry args={[0.24, 0.26]} />
            <meshBasicMaterial color="#150d05" />
          </mesh>
        </group>
      )}
      <HingedDoor open={doorOpen} w={w} y={base + 0.85} z={df + 0.03} color={doorCol} />
      {/* Stone doorstep */}
      <mesh position={[0, 0.07, df + 0.32]} receiveShadow>
        <boxGeometry args={[w * 0.2 + 0.36, 0.14, 0.55]} />
        <meshStandardMaterial color="#9c968c" roughness={1} />
      </mesh>
      {/* A little awning over the door + stepping stones toward the street */}
      {detail && (
        <>
          <mesh position={[0, base + 2.02, df + 0.3]} rotation={[0.42, 0, 0]} castShadow>
            <boxGeometry args={[w * 0.2 + 0.34, 0.06, 0.75]} />
            <meshStandardMaterial color={shade(roof, 0.85)} roughness={0.9} />
          </mesh>
          {[0.9, 1.7, 2.5].map((d, i) => (
            <mesh key={`ss${i}`} position={[i % 2 ? 0.16 : -0.12, 0.012, df + 0.6 + d]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2.3} receiveShadow>
              <circleGeometry args={[0.3 - i * 0.03, 8]} />
              <meshStandardMaterial color="#b9a27b" roughness={1} depthWrite={false} />
            </mesh>
          ))}
        </>
      )}
      {/* Windows with frame + flower box */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * w * 0.26, winY, df]}>
          <mesh>
            <boxGeometry args={[winW + 0.1, winW + 0.1, 0.06]} />
            <meshStandardMaterial color="#efe6d6" roughness={0.9} />
          </mesh>
          <mesh position={[0, 0, 0.03]} material={WINDOW_MAT}>
            <boxGeometry args={[winW, winW, 0.08]} />
          </mesh>
          {/* mullion cross — panes instead of a glowing slab */}
          <mesh position={[0, 0, 0.075]}>
            <boxGeometry args={[0.05, winW, 0.02]} />
            <meshStandardMaterial color="#efe6d6" roughness={0.9} />
          </mesh>
          <mesh position={[0, 0, 0.075]}>
            <boxGeometry args={[winW, 0.05, 0.02]} />
            <meshStandardMaterial color="#efe6d6" roughness={0.9} />
          </mesh>
          {/* shutters in the district door colour */}
          {detail &&
            [-1, 1].map((sh) => (
              <mesh key={`sh${sh}`} position={[sh * (winW * 0.5 + 0.14), 0, 0.02]}>
                <boxGeometry args={[0.18, winW + 0.06, 0.05]} />
                <meshStandardMaterial color={shade(doorCol, 0.9)} roughness={0.9} />
              </mesh>
            ))}
          <mesh position={[0, -winW * 0.6, 0.1]}>
            <boxGeometry args={[winW + 0.12, 0.08, 0.1]} />
            <meshStandardMaterial color="#6b4a2a" roughness={0.9} />
          </mesh>
          {/* Blooms in the flower box */}
          {detail &&
            [-winW * 0.28, 0, winW * 0.28].map((dx, k) => (
              <mesh key={`fl${k}`} position={[dx, -winW * 0.6 + 0.09, 0.12]}>
                <sphereGeometry args={[0.055, 6, 6]} />
                <meshStandardMaterial color={["#f472b6", "#fbbf24", "#f87171"][(k + s + 1) % 3]} roughness={0.7} />
              </mesh>
            ))}
        </group>
      ))}
      {/* Chimney */}
      {chimney && (
        <group>
          <mesh position={[w * 0.26, base + h + roofH * 0.35, w * 0.16]} castShadow>
            <boxGeometry args={[0.4, roofH * 0.7, 0.4]} />
            <meshStandardMaterial color="#8a5a4a" roughness={0.9} />
          </mesh>
          {/* Cap rim + dark flue so the top reads finished */}
          <mesh position={[w * 0.26, base + h + roofH * 0.7 + 0.05, w * 0.16]} castShadow>
            <boxGeometry args={[0.52, 0.14, 0.52]} />
            <meshStandardMaterial color="#6e463a" roughness={0.9} />
          </mesh>
          <mesh position={[w * 0.26, base + h + roofH * 0.7 + 0.14, w * 0.16]}>
            <boxGeometry args={[0.28, 0.08, 0.28]} />
            <meshStandardMaterial color="#2f2a26" roughness={1} />
          </mesh>
        </group>
      )}
      {/* Woodsmoke rises from ABOVE the cap so it never clips through it */}
      {chimney && active && detail && <Smoke position={[w * 0.26, base + h + roofH * 0.7 + 0.85, w * 0.16]} />}
      {/* A varied little yard prop out back */}
      {detail && flair < 0.28 && <Barrel position={[w * 0.3, 0, -w * 0.62]} rotation={flair * 12} />}
      {detail && flair >= 0.28 && flair < 0.5 && <HayBale position={[-w * 0.26, 0, -w * 0.6]} rotation={flair * 9} />}
      {detail && flair >= 0.5 && flair < 0.68 && <Bench position={[w * 0.12, 0, -w * 0.6]} rotation={Math.PI + (flair - 0.5) * 2} />}
    </group>
  );
}

// ——— INSTANCED field trees ————————————————————————————————————————————————
// Every district tree used to be ~13 separate meshes (≈2000+ draw calls across
// the world). Here the whole forest renders as ~18 instanced draw calls — same
// silhouettes, same colours, same wind sway (matrices update per frame).
type FieldTree = { pos: Vec3; s: number; variant: "round" | "pine" | "blossom" | "autumn" };

const TREE_RING5 = [0, 1, 2, 3, 4].map((i) => {
  const a = (i / 5) * Math.PI * 2;
  return [Math.cos(a) * 1.2, 3.35, Math.sin(a) * 1.2] as const;
});
// Canopy blob slots — offsets/radii identical to decor's Canopy.
const BLOB_SLOTS: { off: readonly [number, number, number]; r: number; ck: "a" | "b" | "c" | "hi" }[] = [
  { off: [0, 3.55, 0], r: 1.55, ck: "a" }, // core (the shadow caster)
  ...TREE_RING5.map((off, i) => ({ off, r: 1.0, ck: (i % 2 ? "b" : "a") as "a" | "b" })),
  { off: [0, 2.9, 0], r: 1.15, ck: "c" as const },
  { off: [0, 4.45, 0], r: 0.95, ck: "hi" as const },
  { off: [0.42, 4.2, 0.26], r: 0.6, ck: "hi" as const },
  // Leafy depth: small clumps poking out of the silhouette + a lit tuft.
  { off: [-0.52, 3.95, -0.3], r: 0.62, ck: "hi" as const },
  { off: [0.58, 3.15, 0.45], r: 0.7, ck: "b" as const },
  { off: [-0.62, 3.05, 0.42], r: 0.66, ck: "c" as const },
];
const TREE_PAL: Record<"round" | "blossom" | "autumn", { a: string; b: string; c: string; hi: string }> = (() => {
  const mk = (a: string, b: string) => ({ a, b, c: shade(a, 0.7), hi: lighten(b, 0.42) });
  return { round: mk("#5fbf6a", "#6fcf79"), blossom: mk("#f4a6c0", "#f8bcd0"), autumn: mk("#e08a3c", "#d4652f") };
})();
const PINE_CONES: { off: readonly [number, number, number]; args: [number, number]; c: string }[] = [
  { off: [0, 2.4, 0], args: [1.5, 2], c: "#3f8f5a" },
  { off: [0, 3.4, 0], args: [1.15, 1.8], c: "#469862" },
  { off: [0, 4.3, 0], args: [0.8, 1.5], c: "#3f8f5a" },
];
const Q_BRANCH1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.7));
const Q_BRANCH2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, 0.65));
const Q_IDENT = new THREE.Quaternion();

function InstancedTrees({ trees }: { trees: FieldTree[] }) {
  const blobTrees = useMemo(() => trees.filter((t) => t.variant !== "pine"), [trees]);
  const pines = useMemo(() => trees.filter((t) => t.variant === "pine"), [trees]);
  const blobRefs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const flareRef = useRef<THREE.InstancedMesh>(null);
  const br1Ref = useRef<THREE.InstancedMesh>(null);
  const br2Ref = useRef<THREE.InstancedMesh>(null);
  const pTrunkRef = useRef<THREE.InstancedMesh>(null);
  const pFlareRef = useRef<THREE.InstancedMesh>(null);
  const pConeRefs = useRef<(THREE.InstancedMesh | null)[]>([]);

  // Per-instance canopy colours (variant palettes) — set once.
  useLayoutEffect(() => {
    BLOB_SLOTS.forEach((slot, k) => {
      const mesh = blobRefs.current[k];
      if (!mesh) return;
      blobTrees.forEach((tr, i) => {
        const pal = TREE_PAL[tr.variant as "round" | "blossom" | "autumn"];
        // Per-tree brightness jitter — no two neighbours read identical.
        const j = 0.9 + (((tr.pos[0] * 11 + tr.pos[2] * 7) % 10 + 10) % 10) * 0.022;
        mesh.setColorAt(i, _ic.set(pal[slot.ck]).multiplyScalar(j));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }, [blobTrees]);

  // Wind sway — recompose matrices at HALF framerate: gentle wind reads
  // identically at 30Hz, and this halves the world's single biggest per-frame
  // cost (a matrix recompose + GPU upload for every part of every tree).
  const swayFrame = useRef(0);
  useFrame((state) => {
    swayFrame.current++;
    if (swayFrame.current % 2 === 0) return;
    const t = state.clock.elapsedTime;
    for (let i = 0; i < blobTrees.length; i++) {
      const tr = blobTrees[i];
      const zr = Math.sin(t * 1.1 + tr.pos[0] * 0.12) * 0.03;
      const xr = Math.cos(t * 0.9 + tr.pos[2] * 0.1) * 0.018;
      _ie.set(xr, 0, zr);
      _iq.setFromEuler(_ie);
      // Canopy blobs (spheres — position rotates with the sway, no spin needed)
      for (let k = 0; k < BLOB_SLOTS.length; k++) {
        const mesh = blobRefs.current[k];
        if (!mesh) continue;
        const slot = BLOB_SLOTS[k];
        _ip.set(slot.off[0] * tr.s, slot.off[1] * tr.s, slot.off[2] * tr.s).applyQuaternion(_iq);
        _ip.x += tr.pos[0];
        _ip.z += tr.pos[2];
        const sc = slot.r * tr.s;
        _im.compose(_ip, Q_IDENT, _is.set(sc, sc, sc));
        mesh.setMatrixAt(i, _im);
      }
      // Trunk + root flare + branches tilt with the sway.
      if (trunkRef.current) {
        _ip.set(0, 1 * tr.s, 0).applyQuaternion(_iq);
        _ip.x += tr.pos[0]; _ip.z += tr.pos[2];
        _im.compose(_ip, _iq, _is.set(tr.s, tr.s, tr.s));
        trunkRef.current.setMatrixAt(i, _im);
      }
      if (flareRef.current) {
        _ip.set(0, 0.14 * tr.s, 0).applyQuaternion(_iq);
        _ip.x += tr.pos[0]; _ip.z += tr.pos[2];
        _im.compose(_ip, _iq, _is.set(tr.s, tr.s, tr.s));
        flareRef.current.setMatrixAt(i, _im);
      }
      if (br1Ref.current) {
        _ip.set(0.32 * tr.s, 1.9 * tr.s, 0.1 * tr.s).applyQuaternion(_iq);
        _ip.x += tr.pos[0]; _ip.z += tr.pos[2];
        _im.compose(_ip, _iq2.copy(_iq).multiply(Q_BRANCH1), _is.set(tr.s, tr.s, tr.s));
        br1Ref.current.setMatrixAt(i, _im);
      }
      if (br2Ref.current) {
        _ip.set(-0.28 * tr.s, 2.1 * tr.s, -0.14 * tr.s).applyQuaternion(_iq);
        _ip.x += tr.pos[0]; _ip.z += tr.pos[2];
        _im.compose(_ip, _iq2.copy(_iq).multiply(Q_BRANCH2), _is.set(tr.s, tr.s, tr.s));
        br2Ref.current.setMatrixAt(i, _im);
      }
    }
    for (let i = 0; i < pines.length; i++) {
      const tr = pines[i];
      const zr = Math.sin(t * 1.1 + tr.pos[0] * 0.12) * 0.03;
      const xr = Math.cos(t * 0.9 + tr.pos[2] * 0.1) * 0.018;
      _ie.set(xr, 0, zr);
      _iq.setFromEuler(_ie);
      if (pTrunkRef.current) {
        _ip.set(0, 1 * tr.s, 0).applyQuaternion(_iq);
        _ip.x += tr.pos[0]; _ip.z += tr.pos[2];
        _im.compose(_ip, _iq, _is.set(tr.s, tr.s, tr.s));
        pTrunkRef.current.setMatrixAt(i, _im);
      }
      if (pFlareRef.current) {
        _ip.set(0, 0.14 * tr.s, 0).applyQuaternion(_iq);
        _ip.x += tr.pos[0]; _ip.z += tr.pos[2];
        _im.compose(_ip, _iq, _is.set(tr.s, tr.s, tr.s));
        pFlareRef.current.setMatrixAt(i, _im);
      }
      for (let k = 0; k < PINE_CONES.length; k++) {
        const mesh = pConeRefs.current[k];
        if (!mesh) continue;
        const cone = PINE_CONES[k];
        _ip.set(0, cone.off[1] * tr.s, 0).applyQuaternion(_iq);
        _ip.x += tr.pos[0]; _ip.z += tr.pos[2];
        _im.compose(_ip, _iq, _is.set(tr.s, tr.s, tr.s));
        mesh.setMatrixAt(i, _im);
      }
    }
    for (let k = 0; k < BLOB_SLOTS.length; k++) {
      const mesh = blobRefs.current[k];
      if (mesh) mesh.instanceMatrix.needsUpdate = true;
    }
    const singles = [trunkRef.current, flareRef.current, br1Ref.current, br2Ref.current, pTrunkRef.current, pFlareRef.current];
    for (let k = 0; k < singles.length; k++) {
      const mesh = singles[k];
      if (mesh) mesh.instanceMatrix.needsUpdate = true;
    }
    for (let k = 0; k < PINE_CONES.length; k++) {
      const mesh = pConeRefs.current[k];
      if (mesh) mesh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      <TreeShadowDiscs trees={trees} />
      {/* Blob-canopy trees (round / blossom / autumn) */}
      {blobTrees.length > 0 && (
        <>
          <instancedMesh key={`bt${blobTrees.length}`} ref={trunkRef} args={[undefined, undefined, blobTrees.length]} frustumCulled={false} castShadow>
            <cylinderGeometry args={[0.26, 0.38, 2, 8]} />
            <meshStandardMaterial color="#8a5a2b" roughness={1} />
          </instancedMesh>
          <instancedMesh key={`bf${blobTrees.length}`} ref={flareRef} args={[undefined, undefined, blobTrees.length]} frustumCulled={false}>
            <coneGeometry args={[0.55, 0.4, 8]} />
            <meshStandardMaterial color="#7a4f26" roughness={1} />
          </instancedMesh>
          <instancedMesh key={`b1${blobTrees.length}`} ref={br1Ref} args={[undefined, undefined, blobTrees.length]} frustumCulled={false}>
            <cylinderGeometry args={[0.07, 0.11, 0.9, 6]} />
            <meshStandardMaterial color="#7a4f26" roughness={1} />
          </instancedMesh>
          <instancedMesh key={`b2${blobTrees.length}`} ref={br2Ref} args={[undefined, undefined, blobTrees.length]} frustumCulled={false}>
            <cylinderGeometry args={[0.06, 0.1, 0.8, 6]} />
            <meshStandardMaterial color="#7a4f26" roughness={1} />
          </instancedMesh>
          {BLOB_SLOTS.map((slot, k) => (
            <instancedMesh
              key={`bs${k}-${blobTrees.length}`}
              ref={(el) => { blobRefs.current[k] = el; }}
              args={[undefined, undefined, blobTrees.length]}
              frustumCulled={false}
              castShadow={k === 0}
            >
              <sphereGeometry args={[1, 12, 10]} />
              <meshStandardMaterial roughness={0.9} />
            </instancedMesh>
          ))}
        </>
      )}
      {/* Pines */}
      {pines.length > 0 && (
        <>
          <instancedMesh key={`pt${pines.length}`} ref={pTrunkRef} args={[undefined, undefined, pines.length]} frustumCulled={false} castShadow>
            <cylinderGeometry args={[0.26, 0.38, 2, 8]} />
            <meshStandardMaterial color="#8a5a2b" roughness={1} />
          </instancedMesh>
          <instancedMesh key={`pf${pines.length}`} ref={pFlareRef} args={[undefined, undefined, pines.length]} frustumCulled={false}>
            <coneGeometry args={[0.55, 0.4, 8]} />
            <meshStandardMaterial color="#7a4f26" roughness={1} />
          </instancedMesh>
          {PINE_CONES.map((cone, k) => (
            <instancedMesh
              key={`pc${k}-${pines.length}`}
              ref={(el) => { pConeRefs.current[k] = el; }}
              args={[undefined, undefined, pines.length]}
              frustumCulled={false}
              castShadow={k === 0}
            >
              <coneGeometry args={[cone.args[0], cone.args[1], 8]} />
              <meshStandardMaterial color={cone.c} roughness={0.9} />
            </instancedMesh>
          ))}
        </>
      )}
    </group>
  );
}

// Bushes as 4 instanced blob slots (was 4 meshes per bush).
const BUSH_BLOBS: readonly (readonly [number, number, number, number])[] = [
  [0, 0.4, 0, 0.5], [0.4, 0.3, 0.05, 0.38], [-0.35, 0.32, -0.1, 0.34], [0.1, 0.55, 0.15, 0.3],
];
function InstancedBushes({ positions }: { positions: Vec3[] }) {
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);
  useLayoutEffect(() => {
    BUSH_BLOBS.forEach(([bx, by, bz, br], k) => {
      const mesh = refs.current[k];
      if (!mesh) return;
      positions.forEach((p, i) => {
        _im.compose(_ip.set(p[0] + bx, by, p[2] + bz), Q_IDENT, _is.set(br, br, br));
        mesh.setMatrixAt(i, _im);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  }, [positions]);
  if (positions.length === 0) return null;
  return (
    <group>
      {BUSH_BLOBS.map((_, k) => (
        <instancedMesh
          key={`bu${k}-${positions.length}`}
          ref={(el) => { refs.current[k] = el; }}
          args={[undefined, undefined, positions.length]}
          frustumCulled={false}
          castShadow={k === 0}
        >
          <sphereGeometry args={[1, 10, 10]} />
          <meshStandardMaterial color="#4fae5e" roughness={0.9} />
        </instancedMesh>
      ))}
    </group>
  );
}

// All the loose stones (path stones + field rocks) in ONE instanced draw call.
function InstancedRocks({ rocks }: { rocks: { pos: Vec3; s: number; rot: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    rocks.forEach((rk, i) => {
      _ie.set(0, rk.rot, 0);
      _iq.setFromEuler(_ie);
      _im.compose(_ip.set(rk.pos[0], 0, rk.pos[2]), _iq, _is.set(rk.s, rk.s * 0.7, rk.s));
      mesh.setMatrixAt(i, _im);
      mesh.setColorAt(i, _ic.set(i % 2 ? "#9a958c" : "#908b82"));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [rocks]);
  if (rocks.length === 0) return null;
  return (
    <instancedMesh key={rocks.length} ref={ref} args={[undefined, undefined, rocks.length]} frustumCulled={false} castShadow>
      <dodecahedronGeometry args={[0.5, 0]} />
      <meshStandardMaterial roughness={1} flatShading />
    </instancedMesh>
  );
}

// Sheep + cows grazing the grass — each ambles a slow loop, heading forward, on a
// circular path chosen so it never crosses a building. Live positions are written
// into `reportRef` every frame for petting + player collision.
function Livestock({ area, obstacles, reportRef }: { area: number; obstacles: { x: number; z: number; r: number }[]; reportRef?: React.RefObject<{ x: number; z: number }[]> }) {
  const group = useRef<THREE.Group>(null);
  const animals = useMemo(() => {
    const r = mulberry(0xa11a1c);
    const target = Math.min(20, Math.max(10, Math.round(area / 7)));
    const out: { cx: number; cz: number; radius: number; speed: number; phase: number; kind: string; s: number }[] = [];
    for (let i = 0; i < target; i++) {
      for (let tries = 0; tries < 30; tries++) {
        const a = r() * Math.PI * 2;
        const cRad = 24 + r() * Math.max(12, area - 34);
        const radius = 4 + r() * 6;
        const cx = Math.cos(a) * cRad, cz = Math.sin(a) * cRad;
        if (cRad < 18 || cRad > area) continue;
        // The whole circular path must stay clear of every building footprint.
        if (!obstacles.every((o) => Math.abs(Math.hypot(cx - o.x, cz - o.z) - radius) > o.r + 2)) continue;
        out.push({
          cx, cz, radius,
          speed: (0.07 + r() * 0.11) * (r() < 0.5 ? 1 : -1),
          phase: r() * Math.PI * 2,
          kind: r() < 0.62 ? "sheep" : "cow",
          s: 0.9 + r() * 0.3,
        });
        break;
      }
    }
    return out;
  }, [area, obstacles]);
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.elapsedTime;
    const report = reportRef?.current;
    group.current.children.forEach((child, i) => {
      const p = animals[i];
      const ang = t * p.speed + p.phase;
      child.position.set(p.cx + Math.cos(ang) * p.radius, 0, p.cz + Math.sin(ang) * p.radius);
      // Face the direction of travel (velocity tangent); head (+X) leads.
      const sgn = p.speed >= 0 ? 1 : -1;
      const dx = -Math.sin(ang) * sgn, dz = Math.cos(ang) * sgn;
      child.rotation.y = Math.atan2(-dz, dx);
      if (report) {
        if (!report[i]) report[i] = { x: 0, z: 0 };
        report[i].x = child.position.x;
        report[i].z = child.position.z;
      }
    });
  });
  return (
    <group ref={group}>
      {animals.map((p, i) => (
        <group key={i}>
          {p.kind === "sheep" ? (
            <Sheep position={[0, 0, 0]} scale={p.s} rotation={0} walking coat={["#efe9dc", "#f5f2ec", "#e2d8c6"][i % 3]} />
          ) : (
            <Cow position={[0, 0, 0]} scale={p.s} rotation={0} walking patch={["#5b4632", "#2e2a26", "#7a5a3c"][i % 3]} />
          )}
        </group>
      ))}
    </group>
  );
}

// The Axon logo in 3D — the peaked "A" frame plus its curved swoosh crossbar,
// extruded once at module scope and shared.
// Every house window shares this one material — a single per-frame update
// lights the whole town's windows as dusk falls.
const WINDOW_MAT = new THREE.MeshStandardMaterial({ color: "#bcd9ef", emissive: new THREE.Color("#ffc46b"), emissiveIntensity: 0.2, roughness: 0.3 });
// The plaza logo: matte black by day, a soft teal beacon by night.
const LOGO_MAT = new THREE.MeshPhysicalMaterial({ color: "#17181c", metalness: 0.75, roughness: 0.22, clearcoat: 0.9, clearcoatRoughness: 0.18, emissive: new THREE.Color("#2dd4bf"), emissiveIntensity: 0 });
function NightDriver() {
  useFrame((state) => {
    const n = nightFactor(state.clock.elapsedTime);
    WINDOW_MAT.emissiveIntensity = 0.15 + n * 1.25;
    LOGO_MAT.emissiveIntensity = n * 0.55;
  });
  return null;
}

const AXON_LOGO_GEOS = (() => {
  const frame = new THREE.Shape();
  frame.moveTo(-1.0, -1.0);
  frame.lineTo(-0.3, 1.0);
  frame.lineTo(0.3, 1.0);
  frame.lineTo(1.0, -1.0);
  frame.lineTo(0.52, -1.0);
  frame.lineTo(0.0, 0.42);
  frame.lineTo(-0.52, -1.0);
  frame.closePath();
  // The swoosh crossbar stays INSIDE the A's footprint, with rounded tips.
  const swoosh = new THREE.Shape();
  swoosh.moveTo(-0.02, -0.3);
  swoosh.quadraticCurveTo(0.52, -0.34, 0.94, -0.88);
  swoosh.quadraticCurveTo(0.99, -0.96, 0.88, -0.99);
  swoosh.quadraticCurveTo(0.48, -0.7, 0.06, -0.44);
  swoosh.quadraticCurveTo(-0.1, -0.36, -0.02, -0.3);
  swoosh.closePath();
  const opts = { depth: 0.22, bevelEnabled: true, bevelThickness: 0.075, bevelSize: 0.075, bevelSegments: 6, curveSegments: 28 } as const;
  return {
    frame: new THREE.ExtrudeGeometry(frame, opts),
    swoosh: new THREE.ExtrudeGeometry(swoosh, opts),
  };
})();

// The spawn hub — a paved circular plaza (clean concentric stone rings + a kerb
// of evenly-spaced blocks, no overlapping bits) with a stone monument + glowing
// Axon emblem at its heart, ringed by lamp posts. The landmark you return to.
const PLAZA_R = 11;
interface PlazaFurniture {
  lamps: { x: number; z: number }[];
  benches: { x: number; z: number; ry: number }[];
  stalls: { x: number; z: number; ry: number; awning: string }[];
  flowers: { x: number; z: number }[];
}
// Festive bunting strung lamp-to-lamp around the plaza — ropes + one
// instanced mesh for every little pennant.
function PlazaBunting({ lamps }: { lamps: { x: number; z: number }[] }) {
  const flags = useRef<THREE.InstancedMesh>(null);
  const spans = useMemo(() => {
    // Ring order matters: sort by angle so ropes hug the circle instead of
    // criss-crossing the square.
    const ordered = [...lamps].sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));
    const out: { a: { x: number; z: number }; b: { x: number; z: number }; len: number; yaw: number }[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i];
      const b = ordered[(i + 1) % ordered.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 2 || len > 14) continue; // skip degenerate/cross-plaza spans
      out.push({ a, b, len, yaw: Math.atan2(b.x - a.x, b.z - a.z) });
    }
    return out;
  }, [lamps]);
  const FLAG_COLS = ["#d95f4a", "#e8b23a", "#5a9fd4", "#6a9a4a", "#c05a9e"];
  const PER = 6;
  const QFLIP = useMemo(() => new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)), []);
  useLayoutEffect(() => {
    const mesh = flags.current;
    if (!mesh) return;
    let i = 0;
    for (const sp of spans) {
      for (let k = 1; k <= PER; k++) {
        const f = k / (PER + 1);
        const x = sp.a.x + (sp.b.x - sp.a.x) * f;
        const z = sp.a.z + (sp.b.z - sp.a.z) * f;
        const sag = Math.sin(f * Math.PI) * 0.35;
        _im.compose(_ip.set(x, 3.05 - sag, z), QFLIP, _is.set(1, 1, 1));
        mesh.setMatrixAt(i, _im);
        mesh.setColorAt(i, _ic.set(FLAG_COLS[i % FLAG_COLS.length]));
        i++;
      }
    }
    // park any unused instances out of sight
    for (; i < spans.length * PER; i++) {
      _im.compose(_ip.set(0, -50, 0), QFLIP, _is.set(0.001, 0.001, 0.001));
      mesh.setMatrixAt(i, _im);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spans]);
  if (spans.length === 0) return null;
  return (
    <group>
      {spans.map((sp, i) => (
        <group key={i} position={[(sp.a.x + sp.b.x) / 2, 3.18, (sp.a.z + sp.b.z) / 2]} rotation={[0, sp.yaw, 0]}>
          {/* rope lies along local +z after an X-rotation of the cylinder */}
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.015, 0.015, sp.len, 4]} />
            <meshStandardMaterial color="#4a3a28" roughness={1} />
          </mesh>
        </group>
      ))}
      <instancedMesh key={spans.length * PER} ref={flags} args={[undefined, undefined, spans.length * PER]} frustumCulled={false}>
        <coneGeometry args={[0.13, 0.28, 3]} />
        <meshStandardMaterial roughness={0.85} side={THREE.DoubleSide} />
      </instancedMesh>
    </group>
  );
}

function PlazaKerb({ streetAngles }: { streetAngles: number[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const blocks = useMemo(() => {
    const out: { a: number; even: boolean }[] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const nearStreet = streetAngles.some((sa) => {
        const d = Math.abs(((a - sa + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        return d < 0.21;
      });
      if (!nearStreet) out.push({ a, even: i % 2 === 0 });
    }
    return out;
  }, [streetAngles]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    blocks.forEach((b, i) => {
      _ie.set(0, -b.a, 0);
      _iq.setFromEuler(_ie);
      _im.compose(_ip.set(Math.cos(b.a) * (PLAZA_R - 0.1), 0.11, Math.sin(b.a) * (PLAZA_R - 0.1)), _iq, _is.set(1, 1, 1));
      mesh.setMatrixAt(i, _im);
      mesh.setColorAt(i, _ic.set(b.even ? "#847b70" : "#9a9184"));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [blocks]);
  if (blocks.length === 0) return null;
  return (
    <instancedMesh key={blocks.length} ref={ref} args={[undefined, undefined, blocks.length]} frustumCulled={false} receiveShadow>
      <boxGeometry args={[0.95, 0.24, 0.5]} />
      <meshStandardMaterial roughness={1} />
    </instancedMesh>
  );
}

function CentralPlaza({ detail = true, furniture, streetAngles, title = true }: { detail?: boolean; furniture: PlazaFurniture; streetAngles: number[]; title?: boolean }) {
  const emblem = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (emblem.current) {
      emblem.current.rotation.y = state.clock.elapsedTime * 0.6;
      emblem.current.position.y = 6.0 + Math.sin(state.clock.elapsedTime * 1.5) * 0.12;
    }
  });
  const rings: [number, number, string][] = [
    [0, 3.6, "#c4bba8"],
    [3.6, 6.2, "#b4aa98"],
    [6.2, 8.6, "#c0b6a4"],
    [8.6, 10.6, "#aca291"],
  ];
  return (
    <group>
      {/* Paved concentric rings — flat, non-overlapping (no z-fighting) */}
      {rings.map(([i0, i1, col], i) => (
        <mesh key={i} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <ringGeometry args={[i0, i1, 60]} />
          <meshStandardMaterial color={col} roughness={1} />
        </mesh>
      ))}
      {/* Kerb blocks around the rim — one instanced draw, gaps at the streets */}
      <PlazaKerb streetAngles={streetAngles} />
      <PlazaBunting lamps={furniture.lamps} />
      {/* Monument — tiered stone base + tapered obelisk */}
      <mesh position={[0, 0.35, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[2.5, 2.8, 0.7, 28]} />
        <meshStandardMaterial color="#b8ad9a" roughness={1} />
      </mesh>
      <mesh position={[0, 0.85, 0]} castShadow>
        <cylinderGeometry args={[1.8, 2.1, 0.5, 28]} />
        <meshStandardMaterial color="#cfc6b5" roughness={1} />
      </mesh>
      <mesh position={[0, 2.7, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <cylinderGeometry args={[0.32, 0.7, 3.6, 4]} />
        <meshStandardMaterial color="#d8cfbe" roughness={0.95} />
      </mesh>
      {/* Glowing Axon emblem */}
      <group ref={emblem} position={[0, 6.0, 0]} scale={1.05}>
        <mesh geometry={AXON_LOGO_GEOS.frame} position={[0, 0, -0.11]} material={LOGO_MAT} castShadow />
        <mesh geometry={AXON_LOGO_GEOS.swoosh} position={[0, 0, -0.11]} material={LOGO_MAT} castShadow />
      </group>
      {/* Title sign raised clear of the emblem (hidden on the landing page,
          where the overlay already says AXON WORLD). The plaza's lamps and
          benches render via the world-wide InstancedLamps/InstancedBenches
          pools — not here — so they cost no extra draw calls. */}
      {title && <Signboard text="AXON WORLD" position={[0, 9.6, 0]} scale={7} big />}
      {/* A couple of market stalls */}
      {furniture.stalls.map((s, i) => (
        <MarketStall key={`ms${i}`} position={[s.x, 0.02, s.z]} rotation={s.ry} awning={s.awning} />
      ))}
      {/* Flower beds tucked between the lamps */}
      {furniture.flowers.map((f, i) => (
        <Flowers key={`fb${i}`} position={[f.x, 0.02, f.z]} scale={1.15} />
      ))}
      {/* Teal bunting strung between the lamps */}
      {detail &&
        furniture.lamps.length > 1 &&
        furniture.lamps.map((l1, i) => {
          const l2 = furniture.lamps[(i + 1) % furniture.lamps.length];
          return (
            <group key={`pn${i}`}>
              {[1, 2, 3, 4, 5].map((k) => {
                const f = k / 6;
                return (
                  <mesh key={k} position={[l1.x + (l2.x - l1.x) * f, 3.32 - Math.sin(f * Math.PI) * 0.45, l1.z + (l2.z - l1.z) * f]} rotation={[Math.PI, 0, 0]}>
                    <coneGeometry args={[0.13, 0.3, 3]} />
                    <meshStandardMaterial color={k % 2 ? "#14b8a6" : "#f4e6c8"} roughness={0.8} />
                  </mesh>
                );
              })}
            </group>
          );
        })}
    </group>
  );
}

// A full FISHING AREA — a sandy clearing of its own with a big pond at the
// heart: layered water (deep centre, shimmering surface, drifting ripples), a
// proper dock you can stand on, log seats, a lantern, a "Fishing spot" sign,
// reeds, rocks, lily pads and a fish that jumps now and then.
function Pond({ position, r, seed, dockA, playerRef }: { position: Vec3; r: number; seed: number; dockA: number; playerRef?: React.RefObject<{ x: number; z: number }> }) {
  const props = useMemo(() => {
    const rng = mulberry(seed);
    // Angular distance from the dock — keeps the dock lane clear of props.
    const offDock = (a: number) => Math.abs(((a - dockA + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const lilies: { pos: Vec3; flower: boolean }[] = [];
    for (let i = 0; i < 9; i++) {
      const a = rng() * Math.PI * 2, rr = 0.6 + rng() * (r - 1.4);
      if (offDock(a) < 0.55) continue; // never under the dock or the cast line
      lilies.push({ pos: [Math.cos(a) * rr, 0.1, Math.sin(a) * rr], flower: rng() < 0.5 });
    }
    const reeds: { pos: Vec3; s: number }[] = [];
    const rocks: { pos: Vec3; s: number; rot: number }[] = [];
    const pebbles: { pos: Vec3; s: number; rot: number }[] = [];
    const n = 10 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.45;
      if (offDock(a) < 0.6) continue; // keep the dock approach clear
      reeds.push({ pos: [Math.cos(a) * (r + 0.4), 0, Math.sin(a) * (r + 0.4)], s: 0.75 + rng() * 0.55 });
    }
    for (let i = 0; i < 8; i++) {
      const a = rng() * Math.PI * 2;
      if (offDock(a) < 0.5) continue;
      rocks.push({ pos: [Math.cos(a) * (r + 1.2), 0, Math.sin(a) * (r + 1.2)], s: 0.4 + rng() * 0.55, rot: rng() * Math.PI * 2 });
    }
    // Tiny pebbles dotted along the sand.
    for (let i = 0; i < 12; i++) {
      const a = rng() * Math.PI * 2;
      if (offDock(a) < 0.4) continue;
      pebbles.push({ pos: [Math.cos(a) * (r + 2 + rng() * 1.6), 0, Math.sin(a) * (r + 2 + rng() * 1.6)], s: 0.16 + rng() * 0.16, rot: rng() * Math.PI * 2 });
    }
    // Shore flora on the sand ring — dry grass tufts + little waterside blooms.
    const flora: { pos: Vec3; kind: "tuft" | "bloom"; s: number; c: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const a = rng() * Math.PI * 2;
      if (offDock(a) < 0.5) continue;
      const rad = r + 2.1 + rng() * 2.3;
      flora.push({ pos: [Math.cos(a) * rad, 0.02, Math.sin(a) * rad], kind: rng() < 0.55 ? "tuft" : "bloom", s: 0.8 + rng() * 0.5, c: Math.floor(rng() * 3) });
    }
    // Two log seats on the shore, fixed angles so the layout can give them collision.
    const logs: { a: number }[] = [{ a: dockA + 2.1 }, { a: dockA - 2.1 }];
    return { lilies, reeds, rocks, pebbles, flora, logs, fishColor: rng() < 0.5 ? "#d98a4a" : "#b8c2cc" };
  }, [r, seed, dockA]);

  // Soft white streaks that slowly rotate on the surface — cheap "live" water.
  const shimmerTex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 256);
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineCap = "round";
    const rng = mulberry(seed ^ 0x5ea);
    for (let i = 0; i < 16; i++) {
      const rad = 26 + rng() * 96;
      const a0 = rng() * Math.PI * 2;
      const sweep = 0.35 + rng() * 0.9;
      ctx.globalAlpha = 0.12 + rng() * 0.2;
      ctx.lineWidth = 1.5 + rng() * 3;
      ctx.beginPath();
      ctx.arc(128, 128, rad, a0, a0 + sweep);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }, [seed]);

  const rip1 = useRef<THREE.Mesh>(null), rip2 = useRef<THREE.Mesh>(null), fish = useRef<THREE.Group>(null);
  const shimmer = useRef<THREE.Mesh>(null);
  const duckA = useRef<THREE.Group>(null), duckB = useRef<THREE.Group>(null);
  useFrame((state) => {
    // Far ponds sleep — their ripples/fish/shimmer freeze until you approach.
    const pp = playerRef?.current;
    if (pp && Math.hypot(pp.x - position[0], pp.z - position[2]) > 55) return;
    const t = state.clock.elapsedTime;
    // Ducks paddle slow circles, bobbing with the water.
    [duckA, duckB].forEach((d, i) => {
      if (!d.current) return;
      const sgn = i ? -1 : 1;
      const ang = t * (0.14 + i * 0.05) * sgn + i * 2.6 + seed;
      const rr = r * (0.4 + i * 0.16);
      d.current.position.set(Math.cos(ang) * rr, 0.05 + Math.sin(t * 2.3 + i * 2) * 0.02, Math.sin(ang) * rr);
      const dx = -Math.sin(ang) * sgn, dz = Math.cos(ang) * sgn;
      d.current.rotation.y = Math.atan2(-dz, dx);
      d.current.rotation.z = Math.sin(t * 2.8 + i) * 0.05;
    });
    for (const [ref, off] of [[rip1, 0], [rip2, 0.5]] as const) {
      if (!ref.current) continue;
      const p = (t * 0.35 + off) % 1;
      const s = 0.3 + p * (r * 0.75);
      ref.current.scale.set(s, s, s);
      (ref.current.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.35;
    }
    if (shimmer.current) shimmer.current.rotation.z = t * 0.05;
    // Fish jumps for a slice of each cycle, arcing out of the water.
    if (fish.current) {
      const c = (t * 0.14 + (seed % 100) / 100) % 1;
      if (c < 0.2) {
        const j = c / 0.2;
        fish.current.visible = true;
        fish.current.position.y = Math.sin(j * Math.PI) * 0.9 + 0.1;
        fish.current.rotation.x = (j - 0.5) * 2.4;
      } else if (fish.current.visible) {
        fish.current.visible = false;
      }
    }
  });

  const dx = Math.cos(dockA), dz = Math.sin(dockA);
  return (
    <group position={position}>
      {/* The clearing: sand blending out into the grass. These stacked discs
          draw in an explicit order with no depth writes, so they can't z-fight
          from the sky view (the "flickering brown ring" fix). */}
      <mesh position={[0, 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow renderOrder={1}>
        <circleGeometry args={[r + 6.2, 44]} />
        <meshStandardMaterial color="#a9c47c" roughness={1} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.014, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow renderOrder={1.2}>
        <circleGeometry args={[r + 4.4, 44]} />
        <meshStandardMaterial color="#ddc794" roughness={1} depthWrite={false} />
      </mesh>
      {/* Muddy rim right at the waterline */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow renderOrder={1.4}>
        <circleGeometry args={[r + 1.1, 44]} />
        <meshStandardMaterial color="#b39a6d" roughness={1} depthWrite={false} />
      </mesh>
      {/* Water — main surface, darker deep centre, rotating shimmer */}
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <circleGeometry args={[r, 44]} />
        <meshStandardMaterial color="#4aa3d4" roughness={0.1} metalness={0.45} />
      </mesh>
      <mesh position={[0, 0.066, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2.2}>
        <circleGeometry args={[r * 0.55, 36]} />
        <meshStandardMaterial color="#3d8ec4" roughness={0.15} metalness={0.4} depthWrite={false} />
      </mesh>
      {/* Pale shallow band hugging the shore — reads as depth */}
      <mesh position={[0, 0.07, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2.3}>
        <ringGeometry args={[r * 0.84, r * 0.99, 44]} />
        <meshBasicMaterial color="#8cd4ec" transparent opacity={0.32} depthWrite={false} toneMapped={false} />
      </mesh>
      {/* foam licking the shoreline */}
      <mesh position={[0, 0.075, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2.35}>
        <ringGeometry args={[r * 0.965, r * 1.0, 44]} />
        <meshBasicMaterial color="#f2fbff" transparent opacity={0.4} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={shimmer} position={[0, 0.075, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[r * 0.96, 40]} />
        <meshBasicMaterial map={shimmerTex} transparent opacity={0.55} depthWrite={false} toneMapped={false} />
      </mesh>
      {/* Ripples */}
      <mesh ref={rip1} position={[dx * r * 0.2, 0.08, dz * r * 0.2]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.7, 0.9, 24]} />
        <meshBasicMaterial color="#dff3fb" transparent opacity={0.3} toneMapped={false} />
      </mesh>
      <mesh ref={rip2} position={[-dx * r * 0.3, 0.08, -dz * r * 0.3]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.7, 0.9, 24]} />
        <meshBasicMaterial color="#dff3fb" transparent opacity={0.3} toneMapped={false} />
      </mesh>
      {/* Everything decorative on the shore culls at distance — from afar a
          pond is just its water. (This was 900+ draw calls across the map.) */}
      <Signboard text="🎣 Fishing spot" position={[0, 2.1, 0]} scale={3.4} />
      <WithinRange x={position[0]} z={position[2]} range={60} playerRef={playerRef}>
      {/* The fishing dock — planked, railed, with a bait bucket */}
      <group rotation={[0, Math.atan2(-dz, dx), 0]}>
        {[0, 1, 2, 3, 4].map((i) => (
          <mesh key={`pl${i}`} position={[r - 2.4 + i * 0.86, 0.38, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.78, 0.1, 2]} />
            <meshStandardMaterial color={i % 2 ? "#9c6b3f" : "#916338"} roughness={0.9} />
          </mesh>
        ))}
        {[[r - 2.2, 0.85], [r - 2.2, -0.85], [r - 0.2, 0.85], [r - 0.2, -0.85], [r + 1.5, 0.85], [r + 1.5, -0.85]].map(([px, pz], i) => (
          <mesh key={`po${i}`} position={[px, 0.12, pz]}>
            <cylinderGeometry args={[0.09, 0.09, 0.95, 6]} />
            <meshStandardMaterial color="#5b3a22" roughness={0.9} />
          </mesh>
        ))}
        {/* Side rail on one side */}
        <mesh position={[r - 0.35, 0.78, 0.85]}>
          <boxGeometry args={[3.9, 0.07, 0.07]} />
          <meshStandardMaterial color="#7a5230" roughness={0.9} />
        </mesh>
        {/* Bait bucket at the shore end */}
        <mesh position={[r - 2.1, 0.58, -0.62]} castShadow>
          <cylinderGeometry args={[0.16, 0.13, 0.28, 10]} />
          <meshStandardMaterial color="#6b7a8a" roughness={0.6} metalness={0.4} />
        </mesh>
      </group>
      {/* Log seats + lantern + sign around the shore */}
      {props.logs.map((l, i) => {
        const lx = Math.cos(l.a) * (r + 2.6), lz = Math.sin(l.a) * (r + 2.6);
        return (
          <mesh key={`log${i}`} position={[lx, 0.24, lz]} rotation={[0, -l.a, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.22, 0.22, 1.7, 9]} />
            <meshStandardMaterial color="#7a5230" roughness={0.95} />
          </mesh>
        );
      })}
      {/* (The shore lamp lives in the world-wide InstancedLamps pool.) */}
      <group position={[Math.cos(dockA - 0.6) * (r + 2.7), 0, Math.sin(dockA - 0.6) * (r + 2.7)]}>
        <mesh position={[0, 0.9, 0]} castShadow>
          <cylinderGeometry args={[0.09, 0.11, 1.8, 7]} />
          <meshStandardMaterial color="#7a4a24" roughness={0.9} />
        </mesh>
      </group>
      {/* Jumping fish */}
      <group ref={fish} position={[dx * r * 0.3, 0.1, dz * r * 0.3]} visible={false}>
        <mesh scale={[1, 0.5, 0.4]}>
          <sphereGeometry args={[0.22, 10, 10]} />
          <meshStandardMaterial color={props.fishColor} roughness={0.5} metalness={0.2} />
        </mesh>
        <mesh position={[-0.24, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.14, 0.24, 5]} />
          <meshStandardMaterial color={props.fishColor} roughness={0.5} metalness={0.2} />
        </mesh>
      </group>
      {/* Resident ducks — a white one, plus a mallard on the bigger ponds */}
      <group ref={duckA}>
        <DuckBody mallard={false} />
      </group>
      {r >= 7 && (
        <group ref={duckB}>
          <DuckBody mallard />
        </group>
      )}
      <InstancedLilies items={props.lilies.map((l) => ({ x: l.pos[0], y: l.pos[1], z: l.pos[2], flower: l.flower }))} />
      <InstancedReeds items={props.reeds.map((rd) => ({ x: rd.pos[0], z: rd.pos[2], s: rd.s }))} />
      <InstancedRocks rocks={[...props.rocks, ...props.pebbles]} />
      {/* Shore flora: dry tufts + waterside blooms */}
      {props.flora.map((f, i) =>
        f.kind === "tuft" ? (
          <GrassTuft key={`fo${i}`} position={f.pos} scale={f.s} color="#8fbe6f" />
        ) : (
          <group key={`fo${i}`} position={f.pos} scale={f.s}>
            {([[-0.12, 0, 0], [0.1, 0.08, 1], [0.02, -0.12, 2]] as const).map(([x, z, k]) => (
              <group key={k} position={[x, 0, z]}>
                <mesh position={[0, 0.14, 0]}>
                  <cylinderGeometry args={[0.02, 0.025, 0.28, 4]} />
                  <meshStandardMaterial color="#5a9e4a" roughness={0.9} />
                </mesh>
                <mesh position={[0, 0.3, 0]}>
                  <sphereGeometry args={[0.06, 6, 6]} />
                  <meshStandardMaterial color={["#7cc4e8", "#ffffff", "#f4a6c0"][(f.c + k) % 3]} roughness={0.7} />
                </mesh>
              </group>
            ))}
          </group>
        ),
      )}
      </WithinRange>
    </group>
  );
}

// The edge of the world: a dense, impassable pine forest ring, rolling forested
// hills behind it, and low-poly mountains on the horizon (some snow-capped).
// Replaces the flat green void — from inside you see treeline → hills → peaks.
function BoundaryScenery({ extent }: { extent: number }) {
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const canopyRef = useRef<THREE.InstancedMesh>(null);
  const canopy2Ref = useRef<THREE.InstancedMesh>(null);
  const data = useMemo(() => {
    const r = mulberry(0xb0d3);
    const pines: { x: number; z: number; s: number; c: number }[] = [];
    // Three staggered rows, packed tight so there's no seeing (or walking) through.
    for (let row = 0; row < 3; row++) {
      const rad = extent + 3 + row * 4.6;
      const n = Math.floor((Math.PI * 2 * rad) / 4.1);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + row * 0.11 + (r() - 0.5) * 0.03;
        pines.push({
          x: Math.cos(a) * (rad + (r() - 0.5) * 2.2),
          z: Math.sin(a) * (rad + (r() - 0.5) * 2.2),
          s: 1.05 + r() * 0.85 + row * 0.3,
          c: Math.floor(r() * 3),
        });
      }
    }
    // Layered hill masses — overlapping canopy domes, not single green bumps.
    const hills = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2 + (r() - 0.5) * 0.35;
      const rx = 16 + r() * 18;
      // Stand each dome fully OUTSIDE the treeline — its own radius pushes it out.
      const rad = extent + 16 + rx + r() * 18;
      return {
        x: Math.cos(a) * rad,
        z: Math.sin(a) * rad,
        rx,
        ry: 6 + r() * 7,
        c: ["#4e7d4e", "#557f52", "#47764b"][i % 3],
        o1: { dx: 0.35 + r() * 0.25, dz: (r() - 0.5) * 0.5, s: 0.55 + r() * 0.2, sy: 0.65 + r() * 0.2 },
        o2: { dx: -(0.3 + r() * 0.25), dz: (r() - 0.5) * 0.5, s: 0.5 + r() * 0.2, sy: 0.55 + r() * 0.2 },
      };
    });
    // Mountain massifs — a main peak with shoulder peaks and a scree skirt,
    // snow tracking the tall summits. No more lone triangles.
    const mounts = Array.from({ length: 20 }, (_, i) => {
      const a = (i / 20) * Math.PI * 2 + (r() - 0.5) * 0.22;
      const h = 28 + r() * 42;
      const base = h * (0.85 + r() * 0.35);
      // The scree skirt spans base*1.45 — place every massif so even the skirt
      // (and shoulder peaks) clears the boundary forest instead of clipping
      // through it into the walkable map.
      const rad = extent + 22 + base * 1.45 + r() * 40;
      const shoulders = Array.from({ length: 1 + Math.floor(r() * 2) }, () => ({
        dx: (r() - 0.5) * base * 1.5,
        dz: (r() - 0.5) * base * 1.1,
        h: h * (0.45 + r() * 0.32),
        b: base * (0.45 + r() * 0.25),
        seg: 5 + Math.floor(r() * 3),
      }));
      return {
        x: Math.cos(a) * rad,
        z: Math.sin(a) * rad,
        h,
        base,
        seg: 5 + Math.floor(r() * 3),
        snowy: h > 40,
        c: ["#7d8a93", "#74838d", "#6d7f8a"][i % 3],
        rot: r() * Math.PI,
        shoulders,
      };
    });
    // The FAR range: huge hazy snow peaks behind everything — atmospheric
    // depth so the horizon reads as a real mountain country, not a fence.
    const farPeaks = Array.from({ length: 11 }, (_, i) => {
      const a = (i / 11) * Math.PI * 2 + (r() - 0.5) * 0.3 + 0.15;
      const h = 58 + r() * 46;
      const base = h * (1.0 + r() * 0.35);
      return {
        x: Math.cos(a) * (extent + 150 + r() * 90),
        z: Math.sin(a) * (extent + 150 + r() * 90),
        h,
        base,
        seg: 6 + Math.floor(r() * 3),
        c: ["#8b98a5", "#93a0ac", "#87939f"][i % 3],
        rot: r() * Math.PI,
      };
    });
    // Rocky foothills — the transition band between forest hills and rock.
    const foothills = Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2 + (r() - 0.5) * 0.35;
      const h = 8 + r() * 10;
      return {
        x: Math.cos(a) * (extent + 26 + r() * 24),
        z: Math.sin(a) * (extent + 26 + r() * 24),
        h,
        base: h * (1.2 + r() * 0.5),
        seg: 5 + Math.floor(r() * 3),
        c: ["#5d7361", "#67796a", "#6f7d6a"][i % 3],
        rot: r() * Math.PI,
      };
    });
    return { pines, hills, mounts, farPeaks, foothills };
  }, [extent]);

  useLayoutEffect(() => {
    const trunks = trunkRef.current, canopies = canopyRef.current, tips = canopy2Ref.current;
    if (!trunks || !canopies || !tips) return;
    const GREENS = ["#2f6b40", "#3a7a4a", "#2a6146"];
    const TIPS = ["#3d7c4e", "#488a58", "#387254"];
    _iq.identity();
    data.pines.forEach((p, i) => {
      _im.compose(_ip.set(p.x, 1.4 * p.s, p.z), _iq, _is.set(p.s, p.s, p.s));
      trunks.setMatrixAt(i, _im);
      _im.compose(_ip.set(p.x, 4.6 * p.s, p.z), _iq, _is.set(p.s, p.s, p.s));
      canopies.setMatrixAt(i, _im);
      canopies.setColorAt(i, _ic.set(GREENS[p.c]));
      _im.compose(_ip.set(p.x, 7.3 * p.s, p.z), _iq, _is.set(p.s, p.s, p.s));
      tips.setMatrixAt(i, _im);
      tips.setColorAt(i, _ic.set(TIPS[p.c]));
    });
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    tips.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    if (tips.instanceColor) tips.instanceColor.needsUpdate = true;
  }, [data.pines]);

  return (
    <group>
      {/* The pine wall — two-tier canopies (3 draw calls for ~450 trees) */}
      <instancedMesh key={`t${data.pines.length}`} ref={trunkRef} args={[undefined, undefined, data.pines.length]} frustumCulled={false}>
        <cylinderGeometry args={[0.32, 0.48, 2.8, 6]} />
        <meshStandardMaterial color="#6b4a2a" roughness={1} />
      </instancedMesh>
      <instancedMesh key={`c${data.pines.length}`} ref={canopyRef} args={[undefined, undefined, data.pines.length]} frustumCulled={false}>
        <coneGeometry args={[2.6, 6, 7]} />
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh key={`c2${data.pines.length}`} ref={canopy2Ref} args={[undefined, undefined, data.pines.length]} frustumCulled={false}>
        <coneGeometry args={[1.7, 4.6, 7]} />
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      {/* Rolling forest hills — overlapping canopy domes */}
      {data.hills.map((h, i) => (
        <group key={`h${i}`} position={[h.x, 0, h.z]}>
          <mesh scale={[h.rx, h.ry, h.rx]}>
            <sphereGeometry args={[1, 14, 10]} />
            <meshStandardMaterial color={h.c} roughness={1} />
          </mesh>
          <mesh position={[h.rx * h.o1.dx, 0, h.rx * h.o1.dz]} scale={[h.rx * h.o1.s, h.ry * h.o1.sy, h.rx * h.o1.s]}>
            <sphereGeometry args={[1, 12, 9]} />
            <meshStandardMaterial color={shade(h.c, 0.86)} roughness={1} />
          </mesh>
          <mesh position={[h.rx * h.o2.dx, 0, h.rx * h.o2.dz]} scale={[h.rx * h.o2.s, h.ry * h.o2.sy, h.rx * h.o2.s]}>
            <sphereGeometry args={[1, 12, 9]} />
            <meshStandardMaterial color={shade(h.c, 0.93)} roughness={1} />
          </mesh>
        </group>
      ))}
      {/* The far range — hazy giants on the horizon, snow to the shoulders */}
      {data.farPeaks.map((m, i) => (
        <group key={`fp${i}`} position={[m.x, 0, m.z]} rotation={[0, m.rot, 0]}>
          <mesh position={[0, m.h / 2 - 2, 0]}>
            <coneGeometry args={[m.base, m.h, m.seg]} />
            <meshStandardMaterial color={m.c} roughness={1} flatShading />
          </mesh>
          <mesh position={[0, m.h - 2 - m.h * 0.19 + 0.06, 0]}>
            <coneGeometry args={[m.base * 0.38 * 1.045, m.h * 0.38, m.seg]} />
            <meshStandardMaterial color="#f2f6f9" roughness={0.8} flatShading />
          </mesh>
        </group>
      ))}
      {/* Rocky foothills bridge the forest hills into the rock */}
      {data.foothills.map((m, i) => (
        <group key={`fh${i}`} position={[m.x, 0, m.z]} rotation={[0, m.rot, 0]}>
          <mesh position={[0, m.h / 2 - 1.5, 0]}>
            <coneGeometry args={[m.base, m.h, m.seg]} />
            <meshStandardMaterial color={m.c} roughness={1} flatShading />
          </mesh>
        </group>
      ))}
      {/* Mountain massifs — scree skirt + shaded ridge face + shoulders + snow */}
      {data.mounts.map((m, i) => (
        <group key={`m${i}`} position={[m.x, 0, m.z]} rotation={[0, m.rot, 0]}>
          <mesh position={[0, m.h * 0.1 - 2, 0]}>
            <coneGeometry args={[m.base * 1.45, m.h * 0.28, m.seg + 2]} />
            <meshStandardMaterial color={shade(m.c, 0.82)} roughness={1} flatShading />
          </mesh>
          <mesh position={[0, m.h / 2 - 2, 0]}>
            <coneGeometry args={[m.base, m.h, m.seg]} />
            <meshStandardMaterial color={m.c} roughness={1} flatShading />
          </mesh>
          {/* a darker ridge face gives the peak a faceted, carved look */}
          <mesh position={[m.base * 0.2, m.h * 0.4 - 2, m.base * 0.12]} rotation={[0, 0.5, 0]}>
            <coneGeometry args={[m.base * 0.55, m.h * 0.8, Math.max(4, m.seg - 1)]} />
            <meshStandardMaterial color={shade(m.c, 0.74)} roughness={1} flatShading />
          </mesh>
          {m.snowy && (
            /* Snow cap sized to the cone's own slope (radius = base·height-fraction)
               so white meets rock in a flush line, not a jutting ledge. */
            <mesh position={[0, m.h - 2 - m.h * 0.15 + 0.06, 0]}>
              <coneGeometry args={[m.base * 0.3 * 1.045, m.h * 0.3, m.seg]} />
              <meshStandardMaterial color="#eef3f6" roughness={0.8} flatShading />
            </mesh>
          )}
          {m.shoulders.map((s, k) => (
            <group key={k} position={[s.dx, 0, s.dz]}>
              <mesh position={[0, s.h / 2 - 2, 0]}>
                <coneGeometry args={[s.b, s.h, s.seg]} />
                <meshStandardMaterial color={shade(m.c, 0.92)} roughness={1} flatShading />
              </mesh>
              {s.h > 40 && (
                <mesh position={[0, s.h - 2 - s.h * 0.13 + 0.05, 0]}>
                  <coneGeometry args={[s.b * 0.26 * 1.045, s.h * 0.26, s.seg]} />
                  <meshStandardMaterial color="#eef3f6" roughness={0.8} flatShading />
                </mesh>
              )}
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}

// Instanced orchard apple trees — pixel-identical to the old per-spot
// <AppleTree> (decor's round <Tree> + six apples), but every orchard tree in
// the world renders in seven draw calls total and never pops in.
const APPLE_SPOTS: Vec3[] = [
  [0.9, 3.2, 0.5], [-0.8, 3.4, -0.4], [0.2, 2.9, -0.95], [-0.45, 3.05, 0.85], [1.05, 3.8, -0.35], [-1.1, 3.7, 0.2],
];
// decor Canopy blob layout for the round variant (core kept separate — it's
// the only blob that casts a shadow, matching decor exactly).
const ORCHARD_CANOPY_CORE = { pos: [0, 3.55, 0] as Vec3, r: 1.55, color: "#5fbf6a" };
const ORCHARD_CANOPY_BLOBS: { pos: Vec3; r: number; color: string }[] = (() => {
  const a = "#5fbf6a";
  const b = "#6fcf79";
  const c = shade(a, 0.76);
  const hi = lighten(b, 0.34);
  const blobs: { pos: Vec3; r: number; color: string }[] = [];
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    blobs.push({ pos: [Math.cos(ang) * 1.2, 3.35, Math.sin(ang) * 1.2], r: 1.0, color: i % 2 ? b : a });
  }
  blobs.push({ pos: [0, 2.9, 0], r: 1.15, color: c }); // shadow underside
  blobs.push({ pos: [0, 4.45, 0], r: 0.95, color: hi }); // top highlight
  blobs.push({ pos: [0.42, 4.2, 0.26], r: 0.6, color: hi });
  return blobs;
})();
const Q_STUB1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.7));
const Q_STUB2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, 0.65));
function InstancedAppleTrees({ items }: { items: { x: number; z: number; s: number }[] }) {
  const trunk = useRef<THREE.InstancedMesh>(null);
  const root = useRef<THREE.InstancedMesh>(null);
  const stub1 = useRef<THREE.InstancedMesh>(null);
  const stub2 = useRef<THREE.InstancedMesh>(null);
  const core = useRef<THREE.InstancedMesh>(null);
  const blobs = useRef<THREE.InstancedMesh>(null);
  const apples = useRef<THREE.InstancedMesh>(null);
  const n = items.length;
  useLayoutEffect(() => {
    const tk = trunk.current, rt = root.current, s1 = stub1.current, s2 = stub2.current, co = core.current, bl = blobs.current, ap = apples.current;
    if (!tk || !rt || !s1 || !s2 || !co || !bl || !ap) return;
    _iq.identity();
    items.forEach((it, i) => {
      const s = it.s;
      _im.compose(_ip.set(it.x, 1 * s, it.z), _iq, _is.set(s, s, s));
      tk.setMatrixAt(i, _im);
      _im.compose(_ip.set(it.x, 0.14 * s, it.z), _iq, _is.set(s, s, s));
      rt.setMatrixAt(i, _im);
      _im.compose(_ip.set(it.x + 0.32 * s, 1.9 * s, it.z + 0.1 * s), Q_STUB1, _is.set(s, s, s));
      s1.setMatrixAt(i, _im);
      _im.compose(_ip.set(it.x - 0.28 * s, 2.1 * s, it.z - 0.14 * s), Q_STUB2, _is.set(s, s, s));
      s2.setMatrixAt(i, _im);
      const cs = ORCHARD_CANOPY_CORE.r * s;
      _im.compose(_ip.set(it.x, ORCHARD_CANOPY_CORE.pos[1] * s, it.z), _iq, _is.set(cs, cs, cs));
      co.setMatrixAt(i, _im);
      co.setColorAt(i, _ic.set(ORCHARD_CANOPY_CORE.color));
      ORCHARD_CANOPY_BLOBS.forEach((blob, k) => {
        const bs = blob.r * s;
        _im.compose(_ip.set(it.x + blob.pos[0] * s, blob.pos[1] * s, it.z + blob.pos[2] * s), _iq, _is.set(bs, bs, bs));
        bl.setMatrixAt(i * ORCHARD_CANOPY_BLOBS.length + k, _im);
        bl.setColorAt(i * ORCHARD_CANOPY_BLOBS.length + k, _ic.set(blob.color));
      });
      APPLE_SPOTS.forEach((p, k) => {
        const as = 0.14 * s;
        _im.compose(_ip.set(it.x + p[0] * s, p[1] * s, it.z + p[2] * s), _iq, _is.set(as, as, as));
        ap.setMatrixAt(i * APPLE_SPOTS.length + k, _im);
        ap.setColorAt(i * APPLE_SPOTS.length + k, _ic.set(k % 3 ? "#d9382e" : "#e8b02e"));
      });
    });
    for (const mesh of [tk, rt, s1, s2, co, bl, ap]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [items]);
  if (n === 0) return null;
  return (
    <group>
      <instancedMesh key={`atk${n}`} ref={trunk} args={[undefined, undefined, n]} frustumCulled={false} castShadow>
        <cylinderGeometry args={[0.26, 0.38, 2, 8]} />
        <meshStandardMaterial color="#8a5a2b" roughness={1} />
      </instancedMesh>
      <instancedMesh key={`art${n}`} ref={root} args={[undefined, undefined, n]} frustumCulled={false} castShadow>
        <coneGeometry args={[0.55, 0.4, 8]} />
        <meshStandardMaterial color="#7a4f26" roughness={1} />
      </instancedMesh>
      <instancedMesh key={`as1${n}`} ref={stub1} args={[undefined, undefined, n]} frustumCulled={false}>
        <cylinderGeometry args={[0.07, 0.11, 0.9, 6]} />
        <meshStandardMaterial color="#7a4f26" roughness={1} />
      </instancedMesh>
      <instancedMesh key={`as2${n}`} ref={stub2} args={[undefined, undefined, n]} frustumCulled={false}>
        <cylinderGeometry args={[0.06, 0.1, 0.8, 6]} />
        <meshStandardMaterial color="#7a4f26" roughness={1} />
      </instancedMesh>
      <instancedMesh key={`aco${n}`} ref={core} args={[undefined, undefined, n]} frustumCulled={false} castShadow>
        <sphereGeometry args={[1, 12, 10]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh key={`abl${n}`} ref={blobs} args={[undefined, undefined, n * ORCHARD_CANOPY_BLOBS.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 12, 10]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh key={`aap${n}`} ref={apples} args={[undefined, undefined, n * APPLE_SPOTS.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshStandardMaterial roughness={0.55} />
      </instancedMesh>
    </group>
  );
}

// Instanced berry bushes — pixel-identical to the old per-spot <BerryBush>
// (decor's <Bush> at scale 1.15 + seven berries): two draw calls for every
// bush in the world, always visible.
const BUSH_LOBES: { pos: Vec3; r: number }[] = [
  { pos: [0, 0.4, 0], r: 0.5 }, { pos: [0.4, 0.3, 0.05], r: 0.38 }, { pos: [-0.35, 0.32, -0.1], r: 0.34 }, { pos: [0.1, 0.55, 0.15], r: 0.3 },
];
const BERRY_SPOTS: Vec3[] = [
  [0.3, 0.5, 0.3], [-0.32, 0.42, 0.22], [0.12, 0.66, -0.2], [-0.15, 0.55, -0.33], [0.42, 0.34, -0.1], [-0.05, 0.72, 0.12], [0.05, 0.4, 0.42],
];
function InstancedBerryBushes({ items }: { items: { x: number; z: number; s: number }[] }) {
  const lobes = useRef<THREE.InstancedMesh>(null);
  const berries = useRef<THREE.InstancedMesh>(null);
  const n = items.length;
  useLayoutEffect(() => {
    const lo = lobes.current, be = berries.current;
    if (!lo || !be) return;
    _iq.identity();
    items.forEach((it, i) => {
      BUSH_LOBES.forEach((blob, k) => {
        // The old bush group sat at scale 1.15 inside the s-scaled group.
        const bs = blob.r * 1.15 * it.s;
        _im.compose(_ip.set(it.x + blob.pos[0] * 1.15 * it.s, blob.pos[1] * 1.15 * it.s, it.z + blob.pos[2] * 1.15 * it.s), _iq, _is.set(bs, bs, bs));
        lo.setMatrixAt(i * BUSH_LOBES.length + k, _im);
      });
      BERRY_SPOTS.forEach((p, k) => {
        const bs = 0.06 * it.s;
        _im.compose(_ip.set(it.x + p[0] * it.s, p[1] * it.s, it.z + p[2] * it.s), _iq, _is.set(bs, bs, bs));
        be.setMatrixAt(i * BERRY_SPOTS.length + k, _im);
        be.setColorAt(i * BERRY_SPOTS.length + k, _ic.set(k % 4 === 3 ? "#7a5fd0" : "#4f6ed8"));
      });
    });
    lo.instanceMatrix.needsUpdate = true;
    be.instanceMatrix.needsUpdate = true;
    if (be.instanceColor) be.instanceColor.needsUpdate = true;
  }, [items]);
  if (n === 0) return null;
  return (
    <group>
      <instancedMesh key={`blo${n}`} ref={lobes} args={[undefined, undefined, n * BUSH_LOBES.length]} frustumCulled={false} castShadow>
        <sphereGeometry args={[1, 10, 10]} />
        <meshStandardMaterial color="#4fae5e" roughness={0.9} />
      </instancedMesh>
      <instancedMesh key={`bbe${n}`} ref={berries} args={[undefined, undefined, n * BERRY_SPOTS.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 6, 6]} />
        <meshStandardMaterial roughness={0.4} />
      </instancedMesh>
    </group>
  );
}

// A campfire circle — stone ring, flickering flames, drifting smoke and log
// seats all around (the logs are sittable via the bench system).
function Campfire({ position }: { position: Vec3 }) {
  const flames = useRef<THREE.Group>(null);
  const glow = useRef<THREE.PointLight>(null);
  const embers = useRef<THREE.Mesh>(null);
  const sparks = useRef<THREE.Group>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (flames.current) {
      flames.current.children.forEach((f, i) => {
        const fl = 0.85 + Math.sin(t * 9 + i * 2.1) * 0.15 + Math.sin(t * 23 + i * 5) * 0.06;
        f.scale.set(fl, fl * (1 + Math.sin(t * 13 + i) * 0.12), fl);
        f.rotation.y = t * (1.2 + i * 0.4);
      });
    }
    if (glow.current) glow.current.intensity = 5.2 + Math.sin(t * 11) * 0.9 + Math.sin(t * 27) * 0.5;
    // Pulsing ember bed.
    if (embers.current) {
      (embers.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.9 + Math.sin(t * 5.5) * 0.35 + Math.sin(t * 17) * 0.15;
    }
    // Sparks spiral up out of the fire and wink out.
    if (sparks.current) {
      sparks.current.children.forEach((sp, i) => {
        const ph = (t * (0.5 + (i % 3) * 0.17) + i * 0.37) % 1;
        sp.position.set(
          Math.sin(ph * 9 + i * 2) * 0.22 * (1 + ph),
          0.35 + ph * 1.9,
          Math.cos(ph * 7 + i * 3) * 0.22 * (1 + ph),
        );
        sp.scale.setScalar(Math.max(0.01, (1 - ph) * 0.8));
      });
    }
  });
  return (
    <group position={position}>
      {/* Stone ring + ember bed */}
      {Array.from({ length: 7 }).map((_, i) => {
        const a = (i / 7) * Math.PI * 2;
        return <Rock key={i} position={[Math.cos(a) * 0.85, 0, Math.sin(a) * 0.85]} scale={0.34} rotation={a * 2} />;
      })}
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2.3}>
        <circleGeometry args={[0.75, 12]} />
        <meshStandardMaterial color="#3a2d24" roughness={1} depthWrite={false} />
      </mesh>
      {/* Glowing embers under the flames */}
      <mesh ref={embers} position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2.4}>
        <circleGeometry args={[0.42, 10]} />
        <meshStandardMaterial color="#ff6a1a" emissive="#ff4a00" emissiveIntensity={1} toneMapped={false} depthWrite={false} />
      </mesh>
      {/* Charred logs */}
      {[0.5, 2.1].map((a, i) => (
        <mesh key={`cl${i}`} position={[0, 0.12, 0]} rotation={[0, a, Math.PI / 2]}>
          <cylinderGeometry args={[0.09, 0.09, 1, 6]} />
          <meshStandardMaterial color="#2f241c" roughness={1} />
        </mesh>
      ))}
      {/* Flames */}
      <group ref={flames}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[Math.cos(i * 2.1) * 0.14, 0.42, Math.sin(i * 2.1) * 0.14]}>
            <coneGeometry args={[0.2 - i * 0.04, 0.75 - i * 0.12, 6]} />
            <meshStandardMaterial
              color={i === 0 ? "#ff8a2a" : i === 1 ? "#ffb23a" : "#ffe08a"}
              emissive={i === 0 ? "#e85a1a" : "#e8931a"}
              emissiveIntensity={1.6}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
      {/* Rising sparks */}
      <group ref={sparks}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <mesh key={i}>
            <octahedronGeometry args={[0.045, 0]} />
            <meshBasicMaterial color={i % 2 ? "#ffb84a" : "#ff8a2a"} toneMapped={false} />
          </mesh>
        ))}
      </group>
      {/* Woodpile beside the fire */}
      <group position={[1.55, 0, -0.7]} rotation={[0, 0.5, 0]}>
        {[[-0.12, 0.12, 0], [0.12, 0.12, 0.02], [0, 0.32, 0.01]].map(([x, y, z], i) => (
          <mesh key={i} position={[x, y, z]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.11, 0.11, 0.85, 7]} />
            <meshStandardMaterial color={i === 2 ? "#8a5f38" : "#7a5230"} roughness={0.95} />
          </mesh>
        ))}
      </group>
      {/* Roasting stick leaning over the fire, marshmallow on the tip */}
      <group position={[-0.95, 0, 0.75]} rotation={[0, 2.4, 0]}>
        <mesh position={[0, 0.42, 0.55]} rotation={[0.9, 0, 0]}>
          <cylinderGeometry args={[0.025, 0.035, 1.5, 5]} />
          <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.95, 1.12]}>
          <boxGeometry args={[0.14, 0.14, 0.16]} />
          <meshStandardMaterial color="#fdf6e8" roughness={0.85} />
        </mesh>
      </group>
      <pointLight ref={glow} position={[0, 1.1, 0]} color="#ff9a3c" intensity={5.2} distance={11} decay={1.6} />
      <Smoke position={[0, 1.15, 0]} />
    </group>
  );
}

// A paddling duck (forward = +X) — white farm duck or a green-headed mallard.
function DuckBody({ mallard }: { mallard: boolean }) {
  return (
    <group>
      <mesh position={[0, 0.14, 0]} scale={[1.25, 0.85, 0.85]} castShadow>
        <sphereGeometry args={[0.2, 10, 10]} />
        <meshStandardMaterial color={mallard ? "#8a6a4a" : "#f2eee4"} roughness={0.9} />
      </mesh>
      {/* Tail tips up */}
      <mesh position={[-0.24, 0.22, 0]} rotation={[0, 0, 0.8]}>
        <coneGeometry args={[0.07, 0.16, 5]} />
        <meshStandardMaterial color={mallard ? "#7a5c3e" : "#e6e0d2"} roughness={0.9} />
      </mesh>
      {/* Head + beak + eyes */}
      <mesh position={[0.2, 0.32, 0]} castShadow>
        <sphereGeometry args={[0.11, 10, 10]} />
        <meshStandardMaterial color={mallard ? "#2e6b46" : "#f2eee4"} roughness={0.8} />
      </mesh>
      <mesh position={[0.32, 0.3, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.04, 0.12, 5]} />
        <meshStandardMaterial color="#e8a03a" roughness={0.8} />
      </mesh>
      {[0.06, -0.06].map((z, k) => (
        <mesh key={k} position={[0.26, 0.35, z]}>
          <sphereGeometry args={[0.018, 6, 6]} />
          <meshStandardMaterial color="#1c1a18" roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

// A giant bounce mushroom — step on the cap and you're launched into the air.
// The whole mushroom SQUASHES when someone bounces (via bounceFxRef), then
// springs back with a wobble. Gills under the cap, a skirt ring on the stalk,
// and a slight lean give it character.
function BounceShroom({ position, s, fxRef }: { position: Vec3; s: number; fxRef?: React.RefObject<{ x: number; z: number; t: number } | null> }) {
  const body = useRef<THREE.Group>(null);
  const cap = useRef<THREE.Group>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    // Gentle breathing.
    if (cap.current) cap.current.scale.y = 1 + Math.sin(t * 2.2 + position[0]) * 0.045;
    // Bounce squash: dip hard, spring back with an overshoot wobble.
    const fx = fxRef?.current;
    if (body.current) {
      let sy = 1, sxz = 1;
      if (fx && Math.hypot(fx.x - position[0], fx.z - position[2]) < 1.6) {
        const age = (performance.now() - fx.t) / 1000;
        if (age < 0.75) {
          const squash = age < 0.16 ? Math.sin((age / 0.16) * Math.PI * 0.5) : Math.cos(((age - 0.16) / 0.59) * Math.PI * 0.5) * Math.cos((age - 0.16) * 26);
          sy = 1 - 0.34 * squash;
          sxz = 1 + 0.2 * squash;
        }
      }
      body.current.scale.set(sxz, sy, sxz);
    }
  });
  return (
    <group position={position} scale={s} rotation={[0.05, position[0], -0.04]}>
      <group ref={body}>
        {/* Stalk with a skirt ring */}
        <mesh position={[0, 0.35, 0]} castShadow>
          <cylinderGeometry args={[0.4, 0.56, 0.72, 10]} />
          <meshStandardMaterial color="#efe6d2" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.5, 0]}>
          <cylinderGeometry args={[0.5, 0.44, 0.1, 10]} />
          <meshStandardMaterial color="#e0d4bc" roughness={0.9} />
        </mesh>
        <group ref={cap} position={[0, 0.82, 0]}>
          {/* Gills under the cap rim */}
          <mesh position={[0, -0.02, 0]}>
            <cylinderGeometry args={[0.88, 0.62, 0.14, 14]} />
            <meshStandardMaterial color="#f2e3c8" roughness={0.95} />
          </mesh>
          {/* The dome */}
          <mesh castShadow>
            <sphereGeometry args={[0.95, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color="#d94f4f" roughness={0.7} />
          </mesh>
          {([[0.4, 0.3, 0.13], [-0.45, 0.1, 0.11], [0.05, -0.5, 0.12], [-0.2, 0.55, 0.1], [0.55, -0.25, 0.09], [-0.05, 0.15, 0.15]] as const).map(([x, z, r], i) => (
            <mesh key={i} position={[x, Math.sqrt(Math.max(0.05, 0.9 - x * x - z * z)) - 0.02, z]}>
              <sphereGeometry args={[r, 6, 6]} />
              <meshStandardMaterial color="#f4ede0" roughness={0.8} />
            </mesh>
          ))}
        </group>
      </group>
      {/* Tiny toadstool sidekick at the base */}
      <group position={[0.85, 0, 0.35]}>
        <mesh position={[0, 0.12, 0]}>
          <cylinderGeometry args={[0.07, 0.09, 0.24, 7]} />
          <meshStandardMaterial color="#efe6d2" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.26, 0]}>
          <sphereGeometry args={[0.17, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#d94f4f" roughness={0.7} />
        </mesh>
      </group>
    </group>
  );
}

// A treasure dig mound — loose earth with a tell-tale glint. E to dig.
function DigMound({ position, shovel = false }: { position: Vec3; shovel?: boolean }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.16, 0]} scale={[1, 0.45, 1]} castShadow>
        <sphereGeometry args={[0.75, 10, 8]} />
        <meshStandardMaterial color="#7a5a38" roughness={1} />
      </mesh>
      <mesh position={[0.2, 0.3, -0.1]} scale={[1, 0.4, 1]}>
        <sphereGeometry args={[0.3, 8, 6]} />
        <meshStandardMaterial color="#8a6844" roughness={1} />
      </mesh>
      {/* The glint that says "dig here" */}
      <mesh position={[0, 0.72, 0]}>
        <octahedronGeometry args={[0.09, 0]} />
        <meshStandardMaterial color="#ffe9a0" emissive="#d9b45a" emissiveIntensity={0.9} toneMapped={false} />
      </mesh>
      {shovel && (
        <group position={[0.6, 0, 0.4]} rotation={[0.35, 0.4, -0.25]}>
          <mesh position={[0, 0.55, 0]}>
            <cylinderGeometry args={[0.04, 0.04, 1.1, 6]} />
            <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
          </mesh>
          <mesh position={[0, 0.02, 0]}>
            <boxGeometry args={[0.22, 0.3, 0.05]} />
            <meshStandardMaterial color="#9aa0a8" metalness={0.5} roughness={0.4} />
          </mesh>
          <mesh position={[0, 1.12, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.035, 0.035, 0.2, 6]} />
            <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
          </mesh>
        </group>
      )}
    </group>
  );
}

// A ring of ancient standing stones with faint teal runes — an Axon relic site.
function StandingStones({ position }: { position: Vec3 }) {
  return (
    <group position={position}>
      {Array.from({ length: 6 }).map((_, i) => {
        const a = (i / 6) * Math.PI * 2;
        const h = 2.2 + (i % 3) * 0.6;
        return (
          <group key={i} position={[Math.cos(a) * 4.2, 0, Math.sin(a) * 4.2]} rotation={[(i % 2 ? 0.06 : -0.05), -a, i % 3 === 0 ? 0.08 : -0.04]}>
            <mesh position={[0, h / 2, 0]} castShadow>
              <boxGeometry args={[0.9 - (i % 2) * 0.15, h, 0.55]} />
              <meshStandardMaterial color={i % 2 ? "#8a8f8c" : "#7e837f"} roughness={1} flatShading />
            </mesh>
            {/* Rune strip */}
            <mesh position={[0, h * 0.55, 0.29]}>
              <boxGeometry args={[0.14, h * 0.5, 0.03]} />
              <meshStandardMaterial color="#5eead4" emissive="#14b8a6" emissiveIntensity={0.9} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
      {/* Mossy centre slab */}
      <mesh position={[0, 0.12, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.1, 1.3, 0.24, 8]} />
        <meshStandardMaterial color="#6f7a6f" roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 0.26, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 0.06, 8]} />
        <meshStandardMaterial color="#5eead4" emissive="#14b8a6" emissiveIntensity={0.7} toneMapped={false} />
      </mesh>
    </group>
  );
}

// True while the visitor is typing in chat — petting must not react to E then.
function typingNow(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

// Pet the animals! Press E next to a sheep, cow or hen and a little burst of
// hearts floats up from it.
function Petting({
  playerPosRef,
  animalsRef,
  chickens,
  onNear,
}: {
  playerPosRef?: React.RefObject<{ x: number; z: number }>;
  animalsRef?: React.RefObject<{ x: number; z: number }[]>;
  chickens: { x: number; z: number }[];
  onNear?: (near: boolean) => void;
}) {
  const bursts = useRef<({ x: number; z: number; t0: number } | null)[]>([null, null, null, null]);
  const nextSlot = useRef(0);
  const slots = useRef<(THREE.Group | null)[]>([]);
  const nearShown = useRef(false);
  const chickensRef = useRef(chickens);
  useEffect(() => { chickensRef.current = chickens; }, [chickens]);

  const heartTex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#f43f5e";
    ctx.beginPath();
    // Two lobes + a point — a chunky little heart.
    ctx.moveTo(32, 56);
    ctx.bezierCurveTo(6, 36, 8, 12, 24, 12);
    ctx.bezierCurveTo(30, 12, 32, 18, 32, 20);
    ctx.bezierCurveTo(32, 18, 34, 12, 40, 12);
    ctx.bezierCurveTo(56, 12, 58, 36, 32, 56);
    ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingNow() || e.code !== "KeyE") return;
      const p = playerPosRef?.current;
      if (!p) return;
      let best: { x: number; z: number } | null = null;
      let bestD = 2.3;
      for (const t of [...(animalsRef?.current ?? []), ...chickens]) {
        const d = Math.hypot(p.x - t.x, p.z - t.z);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (best) {
        bursts.current[nextSlot.current % 4] = { x: best.x, z: best.z, t0: performance.now() };
        nextSlot.current++;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playerPosRef, animalsRef, chickens]);

  useFrame(() => {
    // Tell the HUD when an animal is close enough to pet.
    const p = playerPosRef?.current;
    if (p && onNear) {
      let near = false;
      for (const t of animalsRef?.current ?? []) {
        if (Math.hypot(p.x - t.x, p.z - t.z) < 2.3) { near = true; break; }
      }
      if (!near) {
        for (const t of chickensRef.current) {
          if (Math.hypot(p.x - t.x, p.z - t.z) < 2.3) { near = true; break; }
        }
      }
      if (near !== nearShown.current) { nearShown.current = near; onNear(near); }
    }
    const now = performance.now();
    for (let i = 0; i < 4; i++) {
      const g = slots.current[i];
      if (!g) continue;
      const b = bursts.current[i];
      const age = b ? (now - b.t0) / 1000 : 99;
      if (!b || age > 1.5) {
        g.visible = false;
        continue;
      }
      g.visible = true;
      g.position.set(b.x, 1.05 + age * 1.15, b.z);
      const op = Math.max(0, 1 - age / 1.5);
      g.children.forEach((c, k) => {
        c.position.x = (k - 1) * 0.28 + Math.sin(age * 5 + k * 2) * 0.07;
        c.position.y = k * 0.22;
        const m = (c as THREE.Sprite).material as THREE.SpriteMaterial;
        m.opacity = op;
      });
    }
  });

  return (
    <group>
      {[0, 1, 2, 3].map((i) => (
        <group key={i} ref={(el) => { slots.current[i] = el; }} visible={false}>
          {[0, 1, 2].map((k) => (
            <sprite key={k} scale={[0.34, 0.34, 1]}>
              <spriteMaterial map={heartTex} transparent depthTest={false} />
            </sprite>
          ))}
        </group>
      ))}
    </group>
  );
}

// The elusive GOLDEN HEN — wanders the meadows, flees when you close in, and
// drops a Golden Egg into your inventory if you manage to tag it. Respawns
// somewhere else after a while.
function GoldenHen({ playerPosRef, extent, obstacles, onCaught }: { playerPosRef?: React.RefObject<{ x: number; z: number }>; extent: number; obstacles: { x: number; z: number; r: number }[]; onCaught?: () => void }) {
  const g = useRef<THREE.Group>(null);
  const spark = useRef<THREE.Mesh>(null);
  const st = useRef({ x: 30, z: 10, heading: Math.PI, cooldown: 0, hops: 0 });
  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = st.current;
    const grp = g.current;
    if (!grp) return;
    if (s.cooldown > 0) {
      s.cooldown -= dt;
      grp.visible = false;
      if (s.cooldown <= 0) {
        // Respawn somewhere new — hop until the spot is on open grass.
        for (let t = 0; t < 12; t++) {
          s.hops++;
          const a = s.hops * 2.399963; // golden-angle hop → spread-out respawns
          const rad = 24 + ((s.hops * 37) % Math.max(20, Math.round(extent) - 44));
          const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
          if (obstacles.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + 1.5)) {
            s.x = x;
            s.z = z;
            break;
          }
        }
      }
      return;
    }
    grp.visible = true;
    const t = state.clock.elapsedTime;
    const p = playerPosRef?.current;
    let vx = 0, vz = 0;
    if (p) {
      const dx = s.x - p.x, dz = s.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.4) {
        onCaught?.();
        s.cooldown = 40; // gone for a while, then reappears elsewhere
        return;
      }
      if (d < 9) {
        // Flee! Slightly slower than a sprinting player, faster than a walk.
        const sp = 7.2;
        vx = (dx / d) * sp;
        vz = (dz / d) * sp;
      }
    }
    if (vx === 0 && vz === 0) {
      // Idle meander.
      vx = Math.cos(t * 0.31) * 0.65;
      vz = Math.sin(t * 0.24) * 0.65;
    }
    s.x += vx * dt;
    s.z += vz * dt;
    // Stay in the meadow band: outside the plaza, inside the world edge.
    const rad = Math.hypot(s.x, s.z) || 1;
    if (rad > extent - 8) { s.x *= (extent - 8) / rad; s.z *= (extent - 8) / rad; }
    if (rad < PLAZA_R + 3) { s.x *= (PLAZA_R + 3) / rad; s.z *= (PLAZA_R + 3) / rad; }
    // Don't flee through houses or into the water.
    for (const o of obstacles) {
      const dx = s.x - o.x, dz = s.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d < o.r + 0.6 && d > 1e-4) {
        s.x = o.x + (dx / d) * (o.r + 0.6);
        s.z = o.z + (dz / d) * (o.r + 0.6);
      }
    }
    s.heading = Math.atan2(-vz, vx);
    grp.position.set(s.x, 0, s.z);
    grp.rotation.y = s.heading;
    if (spark.current) {
      spark.current.rotation.y = t * 2;
      spark.current.position.y = 1.25 + Math.sin(t * 2.4) * 0.08;
    }
  });
  return (
    <group ref={g}>
      <Chicken position={[0, 0, 0]} gold scale={1.15} />
      {/* A little golden glint so you can spot it across the field */}
      <mesh ref={spark} position={[0, 1.25, 0]}>
        <octahedronGeometry args={[0.13, 0]} />
        <meshStandardMaterial color="#ffd977" emissive="#e8a820" emissiveIntensity={1.2} toneMapped={false} />
      </mesh>
    </group>
  );
}

// A little wooden display stand outside the owner's front door — their rarest
// minigame catches, shown off to every visitor as glowing gems. Only rendered
// at houses whose agent belongs to the connected wallet.
function TrophyShelf({ rarities, w, rotation }: { rarities: Rarity[]; w: number; rotation: number }) {
  const df = w / 2; // door face — same frame the house's own door uses
  const gems = rarities.slice(0, 4);
  return (
    <group rotation={[0, rotation, 0]}>
      <group position={[-(w * 0.36), 0, df + 0.6]}>
        {/* stand top + legs */}
        <mesh position={[0, 0.6, 0]}>
          <boxGeometry args={[1.3, 0.09, 0.48]} />
          <meshStandardMaterial color="#7a5a38" roughness={0.9} />
        </mesh>
        <mesh position={[-0.52, 0.3, 0]}>
          <boxGeometry args={[0.09, 0.6, 0.38]} />
          <meshStandardMaterial color="#66492e" roughness={0.95} />
        </mesh>
        <mesh position={[0.52, 0.3, 0]}>
          <boxGeometry args={[0.09, 0.6, 0.38]} />
          <meshStandardMaterial color="#66492e" roughness={0.95} />
        </mesh>
        {/* the trophies — one glowing gem per item, coloured by rarity */}
        {gems.map((r, i) => (
          <group key={i} position={[-0.45 + i * 0.3, 0.72, 0]}>
            <mesh position={[0, 0.035, 0]}>
              <cylinderGeometry args={[0.07, 0.09, 0.07, 8]} />
              <meshStandardMaterial color="#4a4a52" roughness={0.6} metalness={0.3} />
            </mesh>
            <mesh position={[0, 0.17, 0]}>
              <icosahedronGeometry args={[0.1, 0]} />
              <meshStandardMaterial
                color={RARITY_COLOR[r]}
                emissive={RARITY_COLOR[r]}
                emissiveIntensity={0.4}
                roughness={0.3}
              />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}

// A cat sunning on a doorstep — some houses just have one. Tail flicks lazily.
type CatMood = "sleep" | "chill" | "play";

// The status glyph floating over a cat — 💤 drifts upward on a loop.
function CatMoodBubble({ mood }: { mood: CatMood }) {
  const spr = useRef<THREE.Sprite>(null);
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.font = "44px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mood === "sleep" ? "💤" : mood === "play" ? "🧶" : "😺", 32, 36);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, [mood]);
  useFrame((state) => {
    const s = spr.current;
    if (!s) return;
    if (mood === "sleep") {
      const t = (state.clock.elapsedTime * 0.45) % 1;
      s.position.y = 0.55 + t * 0.5;
      (s.material as THREE.SpriteMaterial).opacity = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
    } else {
      s.position.y = 0.62 + Math.sin(state.clock.elapsedTime * 1.6) * 0.04;
      (s.material as THREE.SpriteMaterial).opacity = 0.92;
    }
  });
  return (
    <sprite ref={spr} position={[0, 0.6, 0]} scale={[0.34, 0.34, 1]}>
      <spriteMaterial map={tex} transparent depthWrite={false} />
    </sprite>
  );
}

function DoorCat({ w, rotation, coat, mood = "chill" }: { w: number; rotation: number; coat: string; mood?: CatMood }) {
  const tail = useRef<THREE.Mesh>(null);
  const yarn = useRef<THREE.Mesh>(null);
  const paw = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (tail.current) tail.current.rotation.y = Math.sin(t * (mood === "sleep" ? 0.4 : 1.3)) * (mood === "sleep" ? 0.15 : 0.5);
    if (yarn.current) yarn.current.position.x = 0.32 + Math.sin(t * 2.1) * 0.05;
    if (paw.current) paw.current.rotation.z = -0.5 + Math.sin(t * 2.1) * 0.3;
  });
  const df = w / 2;
  const dark = shade(coat, 0.8);
  return (
    <group rotation={[0, rotation, 0]}>
      <group position={[w * 0.24, 0.15, df + 0.45]} rotation={[0, 0.8, 0]}>
        {mood === "sleep" ? (
          <>
            {/* curled flat, head tucked, tail wrapped around */}
            <mesh position={[0, -0.05, 0]} scale={[1.2, 0.62, 1.1]}>
              <sphereGeometry args={[0.21, 10, 8]} />
              <meshStandardMaterial color={coat} roughness={0.9} />
            </mesh>
            <mesh position={[0.13, -0.02, 0.08]} scale={[1, 0.8, 1]}>
              <sphereGeometry args={[0.11, 10, 8]} />
              <meshStandardMaterial color={coat} roughness={0.9} />
            </mesh>
            <mesh position={[0.1, 0.06, 0.1]} rotation={[0, 0, 0.3]}>
              <coneGeometry args={[0.035, 0.07, 4]} />
              <meshStandardMaterial color={dark} roughness={0.9} />
            </mesh>
            <mesh position={[0.17, 0.05, 0.12]} rotation={[0, 0, -0.3]}>
              <coneGeometry args={[0.035, 0.07, 4]} />
              <meshStandardMaterial color={dark} roughness={0.9} />
            </mesh>
            {/* closed eyes — little sleepy lines */}
            {[0.09, 0.17].map((ex) => (
              <mesh key={ex} position={[ex, -0.01, 0.18]}>
                <boxGeometry args={[0.035, 0.008, 0.01]} />
                <meshStandardMaterial color="#1c1917" roughness={1} />
              </mesh>
            ))}
            <mesh ref={tail} position={[-0.14, -0.1, 0.14]} rotation={[0.2, 0.8, 1.4]}>
              <capsuleGeometry args={[0.032, 0.3, 4, 6]} />
              <meshStandardMaterial color={dark} roughness={0.9} />
            </mesh>
          </>
        ) : (
          <>
            {/* seated: chest up, front paws, proper face */}
            <mesh scale={[1, 1.05, 1]}>
              <sphereGeometry args={[0.21, 10, 8]} />
              <meshStandardMaterial color={coat} roughness={0.9} />
            </mesh>
            <mesh position={[0.16, 0.14, 0.05]}>
              <sphereGeometry args={[0.125, 10, 8]} />
              <meshStandardMaterial color={coat} roughness={0.9} />
            </mesh>
            {/* ears */}
            <mesh position={[0.12, 0.25, 0.03]} rotation={[0, 0, 0.3]}>
              <coneGeometry args={[0.04, 0.08, 4]} />
              <meshStandardMaterial color={dark} roughness={0.9} />
            </mesh>
            <mesh position={[0.21, 0.24, 0.07]} rotation={[0, 0, -0.3]}>
              <coneGeometry args={[0.04, 0.08, 4]} />
              <meshStandardMaterial color={dark} roughness={0.9} />
            </mesh>
            {/* eyes — amber with dark pupils */}
            {[[0.2, 0.16, 0.14], [0.13, 0.16, 0.13]].map(([ex, ey, ez], i) => (
              <group key={i} position={[ex, ey, ez]}>
                <mesh>
                  <sphereGeometry args={[0.024, 6, 6]} />
                  <meshStandardMaterial color="#e8b23c" roughness={0.4} />
                </mesh>
                <mesh position={[0.008, 0, 0.012]}>
                  <sphereGeometry args={[0.012, 5, 5]} />
                  <meshStandardMaterial color="#1c1917" roughness={0.6} />
                </mesh>
              </group>
            ))}
            {/* pink nose */}
            <mesh position={[0.175, 0.11, 0.16]}>
              <sphereGeometry args={[0.014, 5, 5]} />
              <meshStandardMaterial color="#d98a8a" roughness={0.7} />
            </mesh>
            {/* front paws */}
            {[0.04, 0.13].map((pz, i) => (
              <mesh key={i} position={[0.14, -0.14, pz]}>
                <sphereGeometry args={[0.045, 6, 6]} />
                <meshStandardMaterial color={coat} roughness={0.9} />
              </mesh>
            ))}
            {/* chest patch */}
            <mesh position={[0.12, 0.0, 0.09]} scale={[0.6, 0.8, 0.6]}>
              <sphereGeometry args={[0.1, 8, 6]} />
              <meshStandardMaterial color={lighten(coat, 0.3)} roughness={0.9} />
            </mesh>
            <mesh ref={tail} position={[-0.19, 0.02, 0]} rotation={[0, 0, 1.25]}>
              <capsuleGeometry args={[0.035, 0.28, 4, 6]} />
              <meshStandardMaterial color={dark} roughness={0.9} />
            </mesh>
            {mood === "play" && (
              <>
                <mesh ref={paw} position={[0.2, -0.1, 0.16]} rotation={[0, 0, -0.5]}>
                  <capsuleGeometry args={[0.028, 0.12, 4, 6]} />
                  <meshStandardMaterial color={coat} roughness={0.9} />
                </mesh>
                <mesh ref={yarn} position={[0.32, -0.16, 0.2]}>
                  <sphereGeometry args={[0.07, 8, 8]} />
                  <meshStandardMaterial color="#c05a9e" roughness={0.8} />
                </mesh>
              </>
            )}
          </>
        )}
        <CatMoodBubble mood={mood} />
      </group>
    </group>
  );
}

const CAT_COATS = ["#c98a4b", "#57534e", "#e7e0d3", "#2f2a26"];
// Deterministic: roughly one house in five keeps a cat, same house every visit.
function catAt(key: string): string | null {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 5 === 0 ? CAT_COATS[h % CAT_COATS.length] : null;
}

// A laundry line strung between two neighbouring houses — poles, rope and a
// few cloths swaying gently. One line animates a whole street's worth of charm.
function LaundryLine({ a, b }: { a: [number, number]; b: [number, number] }) {
  const cloths = useRef<THREE.Group>(null);
  useFrame((state) => {
    const g = cloths.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    for (let i = 0; i < g.children.length; i++) {
      g.children[i].rotation.x = Math.sin(t * 1.4 + i * 1.7) * 0.16;
    }
  });
  const midX = (a[0] + b[0]) / 2;
  const midZ = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const full = Math.hypot(dx, dz);
  const len = full - 6; // stay clear of both facades
  if (len < 4) return null;
  const ry = Math.atan2(dx, dz);
  const COLORS = ["#e8ddc8", "#a8c4d4", "#d4a8b0", "#c4d4a8"];
  const n = Math.min(4, Math.max(2, Math.floor(len / 2.2)));
  return (
    <group position={[midX, 0, midZ]} rotation={[0, ry, 0]}>
      {[-len / 2, len / 2].map((z) => (
        <mesh key={z} position={[0, 1.05, z]}>
          <cylinderGeometry args={[0.05, 0.06, 2.1, 6]} />
          <meshStandardMaterial color="#6d4c31" roughness={0.95} />
        </mesh>
      ))}
      <mesh position={[0, 2.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.012, 0.012, len, 4]} />
        <meshStandardMaterial color="#4a3a28" roughness={1} />
      </mesh>
      <group ref={cloths}>
        {Array.from({ length: n }, (_, i) => {
          const z = -len / 2 + ((i + 1) / (n + 1)) * len;
          return (
            <group key={i} position={[0, 2.0, z]}>
              <mesh position={[0, -0.26, 0]}>
                <planeGeometry args={[0.06, 0.52]} />
                <meshStandardMaterial color={COLORS[i % COLORS.length]} roughness={0.9} side={THREE.DoubleSide} />
              </mesh>
              <mesh position={[0, -0.26, 0]} rotation={[0, Math.PI / 2, 0]}>
                <planeGeometry args={[0.52, 0.52]} />
                <meshStandardMaterial color={COLORS[i % COLORS.length]} roughness={0.9} side={THREE.DoubleSide} />
              </mesh>
            </group>
          );
        })}
      </group>
    </group>
  );
}

// Fireflies drifting over the pond banks — tiny pulsing points of light.
function Fireflies({ ponds }: { ponds: { pos: [number, number, number]; r: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const flies = useMemo(() => {
    const r = mulberry(0xf1ef);
    return ponds.flatMap((p) =>
      Array.from({ length: 7 }, () => {
        const a = r() * Math.PI * 2;
        const rad = p.r * (0.7 + r() * 0.7);
        return {
          x: p.pos[0] + Math.cos(a) * rad,
          z: p.pos[2] + Math.sin(a) * rad,
          y: 0.5 + r() * 1.3,
          fx: 0.3 + r() * 0.5,
          fy: 0.5 + r() * 0.8,
          ph: r() * Math.PI * 2,
          amp: 0.8 + r() * 1.4,
        };
      }),
    );
  }, [ponds]);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime;
    _iq.identity();
    flies.forEach((fl, i) => {
      const pulse = 0.6 + Math.sin(t * 2.6 + fl.ph * 3) * 0.4; // each blinks on its own beat
      _ip.set(
        fl.x + Math.sin(t * fl.fx + fl.ph) * fl.amp,
        fl.y + Math.sin(t * fl.fy + fl.ph) * 0.35,
        fl.z + Math.cos(t * fl.fx * 0.85 + fl.ph) * fl.amp,
      );
      const sc = 0.03 + pulse * 0.035;
      _im.compose(_ip, _iq, _is.set(sc, sc, sc));
      mesh.setMatrixAt(i, _im);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  if (flies.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, flies.length]} frustumCulled={false}>
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial ref={mat} color="#d8f27a" toneMapped={false} transparent opacity={0.85} />
    </instancedMesh>
  );
}

// The pipeline desk — where a visitor opens a WORK ORDER, walks the streets
// adding agents as steps, and comes back to run the whole chain as a real
// multi-agent workflow. A lectern with a glowing scroll.
function PipelineDesk({ x, z, ry }: { x: number; z: number; ry: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, ry, 0]}>
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[0.24, 1.0, 0.24]} />
        <meshStandardMaterial color="#6d4c31" roughness={0.95} />
      </mesh>
      <mesh position={[0, 1.08, 0.08]} rotation={[-0.5, 0, 0]}>
        <boxGeometry args={[0.95, 0.07, 0.68]} />
        <meshStandardMaterial color="#8a6240" roughness={0.9} />
      </mesh>
      {/* the work-order scroll, faintly glowing */}
      <mesh position={[0, 1.17, 0.12]} rotation={[-0.5, 0, 0]}>
        <boxGeometry args={[0.55, 0.02, 0.42]} />
        <meshStandardMaterial color="#f2e8d0" emissive="#e8d8a8" emissiveIntensity={0.25} roughness={0.8} />
      </mesh>
      <mesh position={[-0.29, 1.16, 0.12]} rotation={[-0.5, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.035, 0.035, 0.44, 8]} />
        <meshStandardMaterial color="#d9c9a0" roughness={0.85} />
      </mesh>
      <Signboard text="PIPELINE DESK" position={[0, 2.15, 0]} scale={3.2} />
    </group>
  );
}

// The river — an arc of water between plaza and districts: sandy banks, two
// blues of water, spring pools at the ends, and a flat plank crossing where
// each street passes over. (Ring segments: world angle = -theta after the
// face-up rotation, hence the negated start.)
// Drifting sun-glints on the river — the ponds' shimmer, flowing along the arc.
function RiverShimmer({ r, t0, span }: { r: number; t0: number; span: number }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 64);
    const rng = mulberry(0x1ee5);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineCap = "round";
    for (let i = 0; i < 22; i++) {
      ctx.globalAlpha = 0.12 + rng() * 0.22;
      ctx.lineWidth = 1.2 + rng() * 2.4;
      const x = rng() * 256;
      const y = 8 + rng() * 48;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 10 + rng() * 26, y);
      ctx.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(6, 1);
    return t;
  }, []);
  useFrame((_, dt) => {
    // eslint-disable-next-line react-hooks/immutability -- scrolling a texture offset is the intended three.js pattern
    tex.offset.x -= Math.min(dt, 0.05) * 0.045; // the water flows
  });
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.065, 0]} renderOrder={2.4}>
      <ringGeometry args={[r - 1.8, r + 1.8, 96, 1, t0, span]} />
      <meshBasicMaterial map={tex} transparent opacity={0.5} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

function River({ river }: { river: { r: number; a0: number; span: number; bridges: number[]; reeds: { pos: Vec3; s: number }[] } }) {
  // The water ribbon stops short of each spring pool so the circles cap the
  // ends cleanly instead of the bands streaking across them.
  const trim = 2.6 / river.r;
  const a0 = river.a0 + trim;
  const span = river.span - trim * 2;
  const t0 = -(a0 + span);
  const ends = [river.a0, river.a0 + river.span];
  return (
    <group>
      {/* banks, water, shallows — layered like the ponds so nothing z-fights */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} renderOrder={1.15}>
        <ringGeometry args={[river.r - 3.3, river.r + 3.3, 96, 1, t0, span]} />
        <meshStandardMaterial color="#c9b489" roughness={1} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.045, 0]} renderOrder={2}>
        <ringGeometry args={[river.r - 2.2, river.r + 2.2, 96, 1, t0, span]} />
        <meshStandardMaterial color="#4aa3d4" roughness={0.15} metalness={0.35} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} renderOrder={2.05}>
        <ringGeometry args={[river.r - 0.9, river.r + 0.9, 96, 1, t0, span]} />
        <meshStandardMaterial color="#3d8ec4" roughness={0.15} metalness={0.4} depthWrite={false} />
      </mesh>
      {/* pale shallow bands hugging both shores — the ponds' depth trick */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]} renderOrder={2.3}>
        <ringGeometry args={[river.r + 1.5, river.r + 2.15, 96, 1, t0, span]} />
        <meshBasicMaterial color="#8cd4ec" transparent opacity={0.32} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]} renderOrder={2.3}>
        <ringGeometry args={[river.r - 2.15, river.r - 1.5, 96, 1, t0, span]} />
        <meshBasicMaterial color="#8cd4ec" transparent opacity={0.32} depthWrite={false} toneMapped={false} />
      </mesh>
      <RiverShimmer r={river.r} t0={t0} span={span} />
      {/* spring pools capping the ends */}
      {ends.map((a, i) => (
        <group key={i} position={[Math.cos(a) * river.r, 0, Math.sin(a) * river.r]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} renderOrder={1.15}>
            <circleGeometry args={[4.4, 28]} />
            <meshStandardMaterial color="#c9b489" roughness={1} depthWrite={false} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.045, 0]} renderOrder={2}>
            <circleGeometry args={[3.4, 28]} />
            <meshStandardMaterial color="#4aa3d4" roughness={0.15} metalness={0.35} depthWrite={false} />
          </mesh>
          {/* darker heart + the ponds' pale shore band */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} renderOrder={2.1}>
            <circleGeometry args={[1.9, 24]} />
            <meshStandardMaterial color="#3d8ec4" roughness={0.15} metalness={0.4} depthWrite={false} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]} renderOrder={2.3}>
            <ringGeometry args={[2.8, 3.35, 28]} />
            <meshBasicMaterial color="#8cd4ec" transparent opacity={0.32} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
      {/* reeds along the banks */}
      <InstancedReeds items={river.reeds.map((rd) => ({ x: rd.pos[0], z: rd.pos[2], s: rd.s }))} />
      {/* lily pads drifting near the banks */}
      <InstancedLilies
        items={[0.16, 0.34, 0.52, 0.72, 0.88]
          .map((f, i) => {
            const a = river.a0 + f * river.span;
            if (river.bridges.some((sa) => Math.abs(a - sa) * river.r < 4)) return null;
            const rr = river.r + (i % 2 ? 0.9 : -0.9);
            return { x: Math.cos(a) * rr, y: 0.07, z: Math.sin(a) * rr, flower: i % 2 === 0 };
          })
          .filter((l): l is { x: number; y: number; z: number; flower: boolean } => l !== null)}
      />
      {/* flat plank crossings where the streets pass over */}
      {river.bridges.map((sa, i) => (
        <group key={`b${i}`} position={[Math.cos(sa) * river.r, 0, Math.sin(sa) * river.r]} rotation={[0, -sa, 0]}>
          {Array.from({ length: 9 }, (_, k) => (
            <mesh key={k} position={[-3.6 + k * 0.9, 0.09, 0]} receiveShadow>
              <boxGeometry args={[0.78, 0.09, 4.8]} />
              <meshStandardMaterial color={k % 2 ? "#8a6240" : "#7d582f"} roughness={0.9} />
            </mesh>
          ))}
          {[-1, 1].map((side) => (
            <group key={side}>
              <mesh position={[0, 0.62, side * 2.5]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.05, 0.05, 7.6, 6]} />
                <meshStandardMaterial color="#6d4c31" roughness={0.9} />
              </mesh>
              {[-3.4, 0, 3.4].map((px) => (
                <mesh key={px} position={[px, 0.33, side * 2.5]}>
                  <boxGeometry args={[0.14, 0.62, 0.14]} />
                  <meshStandardMaterial color="#6d4c31" roughness={0.95} />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}

// The garden's stone fountain: basin, rippling water, a column with a
// spilling crown. The chairs around it face the water.
function GardenFountain({ x, z }: { x: number; z: number }) {
  const rip = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (rip.current) {
      const f = 1 + (Math.sin(state.clock.elapsedTime * 1.8) * 0.5 + 0.5) * 0.5;
      rip.current.scale.set(f, f, 1);
      (rip.current.material as THREE.MeshBasicMaterial).opacity = 0.5 - (f - 1);
    }
  });
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.28, 0]} receiveShadow>
        <cylinderGeometry args={[1.7, 1.85, 0.56, 20]} />
        <meshStandardMaterial color="#9c968c" roughness={1} />
      </mesh>
      <mesh position={[0, 0.57, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <circleGeometry args={[1.5, 20]} />
        <meshStandardMaterial color="#4aa3d4" roughness={0.12} metalness={0.4} depthWrite={false} />
      </mesh>
      <mesh ref={rip} position={[0, 0.585, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2.2}>
        <ringGeometry args={[0.5, 0.62, 20]} />
        <meshBasicMaterial color="#bfe6f4" transparent opacity={0.5} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.9, 0]}>
        <cylinderGeometry args={[0.16, 0.22, 0.75, 10]} />
        <meshStandardMaterial color="#8a847a" roughness={1} />
      </mesh>
      <mesh position={[0, 1.32, 0]}>
        <cylinderGeometry args={[0.5, 0.38, 0.14, 14]} />
        <meshStandardMaterial color="#9c968c" roughness={1} />
      </mesh>
      <mesh position={[0, 1.42, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.42, 14]} />
        <meshStandardMaterial color="#6fc0e8" roughness={0.15} metalness={0.35} />
      </mesh>
    </group>
  );
}

// Instanced reed beds — pixel-identical to decor's <Reed>, but every stalk
// and seed head in the world is two draw calls instead of eight per reed.
const REED_STALKS: [number, number, number, number][] = [
  [-0.12, -0.07, -0.14, 1],
  [0.05, 0.03, 0.04, 0.82],
  [0.14, 0.08, 0.16, 1.08],
  [-0.02, 0.12, -0.05, 0.68],
];
function InstancedReeds({ items }: { items: { x: number; z: number; s: number }[] }) {
  const stalks = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const n = items.length * REED_STALKS.length;
  useLayoutEffect(() => {
    const a = stalks.current;
    const b = heads.current;
    if (!a || !b) return;
    let i = 0;
    for (const it of items) {
      for (let k = 0; k < REED_STALKS.length; k++) {
        const [ox, oz, lean, h] = REED_STALKS[k];
        _ie.set(0, 0, lean);
        _iq.setFromEuler(_ie);
        const bx = it.x + ox * it.s;
        const bz = it.z + oz * it.s;
        _ip.set(0, 0.7 * 1.4 * h * it.s * (1 / 1.4), 0).applyQuaternion(_iq);
        _im.compose(_ip.set(bx + _ip.x, _ip.y, bz + _ip.z), _iq, _is.set(it.s, it.s * h, it.s));
        a.setMatrixAt(i, _im);
        a.setColorAt(i, _ic.set(k % 2 ? "#5a9e4a" : "#6bab55"));
        _ip.set(0, 1.48 * h * it.s, 0).applyQuaternion(_iq);
        _im.compose(_ip.set(bx + _ip.x, _ip.y, bz + _ip.z), _iq, _is.set(it.s, it.s, it.s));
        b.setMatrixAt(i, _im);
        i++;
      }
    }
    a.instanceMatrix.needsUpdate = true;
    b.instanceMatrix.needsUpdate = true;
    if (a.instanceColor) a.instanceColor.needsUpdate = true;
  }, [items]);
  if (n === 0) return null;
  return (
    <group>
      <instancedMesh key={`rs${n}`} ref={stalks} args={[undefined, undefined, n]} frustumCulled={false}>
        <cylinderGeometry args={[0.026, 0.038, 1.4, 5]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh key={`rh${n}`} ref={heads} args={[undefined, undefined, n]} frustumCulled={false}>
        <capsuleGeometry args={[0.06, 0.26, 4, 6]} />
        <meshStandardMaterial color="#7a4a24" roughness={0.95} />
      </instancedMesh>
    </group>
  );
}

// Instanced lily pads (+ their flowers) — same look as decor's <LilyPad>.
function InstancedLilies({ items }: { items: { x: number; y?: number; z: number; flower: boolean }[] }) {
  const outer = useRef<THREE.InstancedMesh>(null);
  const inner = useRef<THREE.InstancedMesh>(null);
  const petals = useRef<THREE.InstancedMesh>(null);
  const flowering = items.filter((l) => l.flower);
  const QF = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  useLayoutEffect(() => {
    const o = outer.current;
    const inr = inner.current;
    const pe = petals.current;
    if (!o || !inr) return;
    items.forEach((l, i) => {
      const y = l.y ?? 0.1;
      _im.compose(_ip.set(l.x, y, l.z), QF, _is.set(1, 1, 1));
      o.setMatrixAt(i, _im);
      _im.compose(_ip.set(l.x, y + 0.004, l.z), QF, _is.set(1, 1, 1));
      inr.setMatrixAt(i, _im);
    });
    o.instanceMatrix.needsUpdate = true;
    inr.instanceMatrix.needsUpdate = true;
    if (pe) {
      let i = 0;
      for (const l of flowering) {
        const y = (l.y ?? 0.1) + 0.03;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          _ie.set(Math.sin(a) * 1.15, 0, -Math.cos(a) * 1.15);
          _iq.setFromEuler(_ie);
          _im.compose(_ip.set(l.x + Math.cos(a) * 0.08, y + 0.05, l.z + Math.sin(a) * 0.08), _iq, _is.set(1, 1, 1));
          pe.setMatrixAt(i, _im);
          i++;
        }
      }
      pe.instanceMatrix.needsUpdate = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  if (items.length === 0) return null;
  return (
    <group>
      <instancedMesh key={`lo${items.length}`} ref={outer} args={[undefined, undefined, items.length]} frustumCulled={false}>
        <circleGeometry args={[0.4, 12]} />
        <meshStandardMaterial color="#3f9a52" roughness={0.8} side={THREE.DoubleSide} />
      </instancedMesh>
      <instancedMesh key={`li${items.length}`} ref={inner} args={[undefined, undefined, items.length]} frustumCulled={false}>
        <circleGeometry args={[0.26, 10]} />
        <meshStandardMaterial color="#4fae62" roughness={0.8} />
      </instancedMesh>
      {flowering.length > 0 && (
        <instancedMesh key={`lp${flowering.length}`} ref={petals} args={[undefined, undefined, flowering.length * 6]} frustumCulled={false}>
          <planeGeometry args={[0.09, 0.14]} />
          <meshStandardMaterial color="#f8d9e8" roughness={0.7} side={THREE.DoubleSide} />
        </instancedMesh>
      )}
    </group>
  );
}

// Instanced lamp posts — pixel-identical to decor's <LampPost>, but EVERY lamp
// in the world (district streets, rest stops, pond shores, plaza) renders in
// five draw calls total and never pops in. The bulbs share decor's exported
// LAMP_BULB_MAT, so LampGlowDriver's night glow still drives them all at once.
const LAMP_PARTS: { y: number }[] = [
  { y: 0.14 }, // base
  { y: 1.7 }, // fluted post
  { y: 3.5 }, // lantern cap
  { y: 3.02 }, // lantern cage
  { y: 3.05 }, // bulb
];
function InstancedLamps({ items }: { items: { x: number; y?: number; z: number }[] }) {
  const base = useRef<THREE.InstancedMesh>(null);
  const post = useRef<THREE.InstancedMesh>(null);
  const cap = useRef<THREE.InstancedMesh>(null);
  const cage = useRef<THREE.InstancedMesh>(null);
  const bulb = useRef<THREE.InstancedMesh>(null);
  const n = items.length;
  useLayoutEffect(() => {
    const refs = [base.current, post.current, cap.current, cage.current, bulb.current];
    _iq.identity();
    refs.forEach((mesh, k) => {
      if (!mesh) return;
      items.forEach((it, i) => {
        _im.compose(_ip.set(it.x, (it.y ?? 0) + LAMP_PARTS[k].y, it.z), _iq, _is.set(1, 1, 1));
        mesh.setMatrixAt(i, _im);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  }, [items]);
  if (n === 0) return null;
  return (
    <group>
      <instancedMesh key={`lba${n}`} ref={base} args={[undefined, undefined, n]} frustumCulled={false} castShadow>
        <cylinderGeometry args={[0.28, 0.34, 0.28, 10]} />
        <meshStandardMaterial color="#3a3833" roughness={0.9} />
      </instancedMesh>
      <instancedMesh key={`lpo${n}`} ref={post} args={[undefined, undefined, n]} frustumCulled={false} castShadow>
        <cylinderGeometry args={[0.09, 0.13, 3.1, 8]} />
        <meshStandardMaterial color="#46443f" roughness={0.85} metalness={0.2} />
      </instancedMesh>
      <instancedMesh key={`lca${n}`} ref={cap} args={[undefined, undefined, n]} frustumCulled={false} castShadow>
        <coneGeometry args={[0.34, 0.34, 6]} />
        <meshStandardMaterial color="#37352f" roughness={0.8} metalness={0.3} />
      </instancedMesh>
      <instancedMesh key={`lcg${n}`} ref={cage} args={[undefined, undefined, n]} frustumCulled={false}>
        <boxGeometry args={[0.34, 0.5, 0.34]} />
        <meshStandardMaterial color="#2f2d28" roughness={0.7} metalness={0.3} />
      </instancedMesh>
      <instancedMesh key={`lbu${n}`} ref={bulb} args={[undefined, undefined, n]} frustumCulled={false} material={LAMP_BULB_MAT}>
        <sphereGeometry args={[0.2, 12, 12]} />
      </instancedMesh>
    </group>
  );
}

// Instanced benches — pixel-identical to decor's <Bench>, batched by material:
// wood slats (per-instance colour), armrest posts and the cast-iron side
// frames. Every repeated bench in the world in three draw calls, always
// visible. Part sizes/offsets lifted verbatim from decor's <Bench>; the tilted
// backrest parts bake the [0, 0.52, -0.28] group offset + rotX(-0.2) in.
const BENCH_TILT_E = new THREE.Euler(-0.2, 0, 0);
const Q_BENCH_TILT = new THREE.Quaternion().setFromEuler(BENCH_TILT_E);
const _benchBack = (y: number): Vec3 => {
  const v = new THREE.Vector3(0, y, 0).applyEuler(BENCH_TILT_E);
  return [v.x, 0.52 + v.y, -0.28 + v.z];
};
const BENCH_WOOD = "#a5713f";
const BENCH_WOOD_DARK = "#8a5a30";
const BENCH_FRAME = "#4a4038";
const BENCH_WOOD_PARTS: { size: Vec3; pos: Vec3; tilt: boolean; color: string }[] = [
  // Seat slats
  { size: [1.7, 0.06, 0.14], pos: [0, 0.46, -0.17], tilt: false, color: BENCH_WOOD },
  { size: [1.7, 0.06, 0.14], pos: [0, 0.46, 0], tilt: false, color: BENCH_WOOD_DARK },
  { size: [1.7, 0.06, 0.14], pos: [0, 0.46, 0.17], tilt: false, color: BENCH_WOOD },
  // Armrest tops
  { size: [0.07, 0.05, 0.5], pos: [-0.82, 0.62, 0.02], tilt: false, color: BENCH_WOOD_DARK },
  { size: [0.07, 0.05, 0.5], pos: [0.82, 0.62, 0.02], tilt: false, color: BENCH_WOOD_DARK },
  // Back slats + top rail (inside the tilted backrest group)
  { size: [1.7, 0.13, 0.05], pos: _benchBack(0.18), tilt: true, color: BENCH_WOOD_DARK },
  { size: [1.7, 0.13, 0.05], pos: _benchBack(0.38), tilt: true, color: BENCH_WOOD },
  { size: [1.76, 0.07, 0.06], pos: _benchBack(0.56), tilt: true, color: BENCH_WOOD_DARK },
];
// Armrest front posts (frame colour, roughness 0.8, no metalness).
const BENCH_POST_PARTS: { size: Vec3; pos: Vec3 }[] = [
  { size: [0.06, 0.16, 0.06], pos: [-0.82, 0.53, 0.2] },
  { size: [0.06, 0.16, 0.06], pos: [0.82, 0.53, 0.2] },
];
// Cast-iron side frames: legs + armrests (roughness 0.7, metalness 0.25).
const BENCH_IRON_PARTS: { size: Vec3; pos: Vec3 }[] = [
  { size: [0.08, 0.46, 0.09], pos: [-0.78, 0.23, 0.14] },
  { size: [0.08, 0.8, 0.09], pos: [-0.78, 0.4, -0.22] },
  { size: [0.09, 0.06, 0.5], pos: [-0.78, 0.66, -0.02] },
  { size: [0.08, 0.46, 0.09], pos: [0.78, 0.23, 0.14] },
  { size: [0.08, 0.8, 0.09], pos: [0.78, 0.4, -0.22] },
  { size: [0.09, 0.06, 0.5], pos: [0.78, 0.66, -0.02] },
];
function InstancedBenches({ items }: { items: { x: number; y?: number; z: number; ry: number }[] }) {
  const wood = useRef<THREE.InstancedMesh>(null);
  const posts = useRef<THREE.InstancedMesh>(null);
  const iron = useRef<THREE.InstancedMesh>(null);
  const n = items.length;
  useLayoutEffect(() => {
    const w = wood.current, p = posts.current, f = iron.current;
    if (!w || !p || !f) return;
    const setPart = (mesh: THREE.InstancedMesh, idx: number, it: { x: number; y?: number; z: number; ry: number }, size: Vec3, pos: Vec3, tilt: boolean) => {
      _iq.setFromEuler(_ie.set(0, it.ry, 0));
      _ip.set(pos[0], pos[1], pos[2]).applyQuaternion(_iq);
      if (tilt) _iq.multiply(Q_BENCH_TILT);
      _im.compose(_ip.set(it.x + _ip.x, (it.y ?? 0) + _ip.y, it.z + _ip.z), _iq, _is.set(size[0], size[1], size[2]));
      mesh.setMatrixAt(idx, _im);
    };
    items.forEach((it, i) => {
      BENCH_WOOD_PARTS.forEach((part, k) => {
        const idx = i * BENCH_WOOD_PARTS.length + k;
        setPart(w, idx, it, part.size, part.pos, part.tilt);
        w.setColorAt(idx, _ic.set(part.color));
      });
      BENCH_POST_PARTS.forEach((part, k) => setPart(p, i * BENCH_POST_PARTS.length + k, it, part.size, part.pos, false));
      BENCH_IRON_PARTS.forEach((part, k) => setPart(f, i * BENCH_IRON_PARTS.length + k, it, part.size, part.pos, false));
    });
    for (const mesh of [w, p, f]) mesh.instanceMatrix.needsUpdate = true;
    if (w.instanceColor) w.instanceColor.needsUpdate = true;
  }, [items]);
  if (n === 0) return null;
  return (
    <group>
      <instancedMesh key={`bw${n}`} ref={wood} args={[undefined, undefined, n * BENCH_WOOD_PARTS.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.85} />
      </instancedMesh>
      <instancedMesh key={`bp${n}`} ref={posts} args={[undefined, undefined, n * BENCH_POST_PARTS.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={BENCH_FRAME} roughness={0.8} />
      </instancedMesh>
      <instancedMesh key={`bi${n}`} ref={iron} args={[undefined, undefined, n * BENCH_IRON_PARTS.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={BENCH_FRAME} roughness={0.7} metalness={0.25} />
      </instancedMesh>
    </group>
  );
}

// Soft shadow discs grounding every tree — one instanced draw call.
function TreeShadowDiscs({ trees }: { trees: { pos: Vec3; s: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const QFLAT = useMemo(() => new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), []);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    trees.forEach((t, i) => {
      _im.compose(_ip.set(t.pos[0], 0.015, t.pos[2]), QFLAT, _is.set(t.s * 1.7, t.s * 1.7, 1));
      mesh.setMatrixAt(i, _im);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trees]);
  if (trees.length === 0) return null;
  return (
    <instancedMesh key={trees.length} ref={ref} args={[undefined, undefined, trees.length]} frustumCulled={false} renderOrder={1.05}>
      <circleGeometry args={[1, 14]} />
      <meshBasicMaterial color="#22301f" transparent opacity={0.22} depthWrite={false} />
    </instancedMesh>
  );
}

// ALL house name signs in ONE mesh: texts drawn into a single atlas texture,
// every sign a fixed board (front + readable back) above its roof. Always
// visible from anywhere — for a single draw call, cheaper than the old culled
// per-house sprites.
function HouseSignAtlas({ houses }: { houses: { key: string; pos: Vec3; rot: number; roofPeak: number; name: string }[] }) {
  const built = useMemo(() => {
    if (houses.length === 0) return null;
    const CW = 256;
    const CH = 64;
    const cols = 8;
    const rows = Math.ceil(houses.length / cols);
    const c = document.createElement("canvas");
    c.width = cols * CW;
    c.height = rows * CH;
    const ctx = c.getContext("2d")!;
    houses.forEach((h, i) => {
      const ox = (i % cols) * CW;
      const oy = Math.floor(i / cols) * CH;
      ctx.fillStyle = "rgba(30,23,12,0.78)";
      const x = ox + 6, y = oy + 6, w = CW - 12, hh = CH - 12, r = 14;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + hh, r);
      ctx.arcTo(x + w, y + hh, x, y + hh, r);
      ctx.arcTo(x, y + hh, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.fill();
      ctx.strokeStyle = "rgba(233,192,94,0.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#f5edd8";
      ctx.font = "600 26px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let t = h.name;
      while (ctx.measureText(t).width > CW - 34 && t.length > 1) t = t.slice(0, -1);
      ctx.fillText(t, ox + CW / 2, oy + CH / 2 + 1);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    // One quad pair per sign — front + mirrored-UV back, pushed apart along the
    // sign's normal with an OPAQUE plank in between. Without the plank both
    // texts are visible at once and the far one reads mirrored through the near.
    const n = houses.length;
    const pos = new Float32Array(n * 8 * 3);
    const uv = new Float32Array(n * 8 * 2);
    const idx = new Uint32Array(n * 12);
    const bpos = new Float32Array(n * 4 * 3);
    const bidx = new Uint32Array(n * 6);
    const W = 5, H = 1.25, GAP = 0.035;
    houses.forEach((h, i) => {
      const cx = h.pos[0], cz = h.pos[2], cy = h.roofPeak + 1.3;
      const sin = Math.sin(h.rot), cos = Math.cos(h.rot);
      const u0 = (i % cols) / cols, u1 = u0 + 1 / cols;
      const v1 = 1 - Math.floor(i / cols) / rows, v0 = v1 - 1 / rows;
      for (let f = 0; f < 2; f++) {
        const base = (i * 8 + f * 4) * 3;
        const ub = (i * 8 + f * 4) * 2;
        const flip = f === 0 ? 1 : -1;
        // corners: (-W/2..W/2) local x, rotated by yaw; each face offset along
        // its own normal so the plank sits between them
        const corners = [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]];
        corners.forEach(([lx, ly], k) => {
          pos[base + k * 3] = cx + lx * cos * flip + sin * GAP * flip;
          pos[base + k * 3 + 1] = cy + ly;
          pos[base + k * 3 + 2] = cz - lx * sin * flip + cos * GAP * flip;
          uv[ub + k * 2] = k === 0 || k === 3 ? u0 : u1;
          uv[ub + k * 2 + 1] = k < 2 ? v0 : v1;
        });
        const ib = i * 12 + f * 6;
        const vb = i * 8 + f * 4;
        idx[ib] = vb; idx[ib + 1] = vb + 1; idx[ib + 2] = vb + 2;
        idx[ib + 3] = vb; idx[ib + 4] = vb + 2; idx[ib + 5] = vb + 3;
      }
      // The plank: one opaque depth-writing quad at the sign's centre plane.
      const bcorners = [[-W / 2 + 0.07, -H / 2 + 0.07], [W / 2 - 0.07, -H / 2 + 0.07], [W / 2 - 0.07, H / 2 - 0.07], [-W / 2 + 0.07, H / 2 - 0.07]];
      bcorners.forEach(([lx, ly], k) => {
        const bb = (i * 4 + k) * 3;
        bpos[bb] = cx + lx * cos;
        bpos[bb + 1] = cy + ly;
        bpos[bb + 2] = cz - lx * sin;
      });
      const bb = i * 6, bv = i * 4;
      bidx[bb] = bv; bidx[bb + 1] = bv + 1; bidx[bb + 2] = bv + 2;
      bidx[bb + 3] = bv; bidx[bb + 4] = bv + 2; bidx[bb + 5] = bv + 3;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const boardGeo = new THREE.BufferGeometry();
    boardGeo.setAttribute("position", new THREE.BufferAttribute(bpos, 3));
    boardGeo.setIndex(new THREE.BufferAttribute(bidx, 1));
    boardGeo.computeVertexNormals();
    return { tex, geo, boardGeo };
  }, [houses]);
  if (!built) return null;
  return (
    <>
      <mesh geometry={built.boardGeo} frustumCulled={false} renderOrder={4}>
        <meshBasicMaterial color="#241b0e" side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={built.geo} frustumCulled={false} renderOrder={5}>
        <meshBasicMaterial map={built.tex} transparent depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
    </>
  );
}

// The garden hedges — plump two-lobe bushes (instanced: two draw calls total),
// jittered so the ring reads as planting, not masonry.
function MazeHedges({ walls }: { walls: { x: number; z: number }[] }) {
  const lo = useRef<THREE.InstancedMesh>(null);
  const hi = useRef<THREE.InstancedMesh>(null);
  const tuft = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const a = lo.current;
    const b = hi.current;
    const c2 = tuft.current;
    if (!a || !b || !c2) return;
    _iq.identity();
    walls.forEach((w, i) => {
      const j = ((w.x * 13 + w.z * 7) % 10) / 10; // stable per-bush jitter
      const s1 = 1.15 + j * 0.35;
      _im.compose(_ip.set(w.x, 0.72 * s1, w.z), _iq, _is.set(s1 * 1.35, s1, s1 * 1.35));
      a.setMatrixAt(i, _im);
      _ic.set(j < 0.33 ? "#3f7d46" : j < 0.66 ? "#46884d" : "#3a7442");
      a.setColorAt(i, _ic);
      const s2 = 0.72 + j * 0.3;
      _im.compose(_ip.set(w.x + (j - 0.5) * 0.7, 1.35 * s1, w.z + (0.5 - j) * 0.6), _iq, _is.set(s2, s2 * 0.9, s2));
      b.setMatrixAt(i, _im);
      _ic.set(j < 0.5 ? "#4f9457" : "#57a05e");
      b.setColorAt(i, _ic);
      // third lobe: a small sunlit tuft on the opposite shoulder
      const s3 = 0.5 + j * 0.24;
      _im.compose(_ip.set(w.x - (j - 0.5) * 0.9, 1.12 * s1, w.z - (0.5 - j) * 0.8), _iq, _is.set(s3, s3 * 0.85, s3));
      c2.setMatrixAt(i, _im);
      _ic.set("#5fae66");
      c2.setColorAt(i, _ic);
    });
    a.instanceMatrix.needsUpdate = true;
    b.instanceMatrix.needsUpdate = true;
    c2.instanceMatrix.needsUpdate = true;
    if (a.instanceColor) a.instanceColor.needsUpdate = true;
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
    if (c2.instanceColor) c2.instanceColor.needsUpdate = true;
  }, [walls]);
  if (walls.length === 0) return null;
  return (
    <group>
      <instancedMesh key={`l${walls.length}`} ref={lo} args={[undefined, undefined, walls.length]} frustumCulled={false} receiveShadow>
        <sphereGeometry args={[1, 10, 8]} />
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh key={`h${walls.length}`} ref={hi} args={[undefined, undefined, walls.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 8]} />
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh key={`t${walls.length}`} ref={tuft} args={[undefined, undefined, walls.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 8, 7]} />
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
    </group>
  );
}

// Wheat: instanced golden stalks filling the farm's field patches.
function WheatField({ stalks }: { stalks: { x: number; z: number; s: number; lean: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    stalks.forEach((w, i) => {
      _ie.set(w.lean, 0, w.lean * 0.7);
      _iq.setFromEuler(_ie);
      _im.compose(_ip.set(w.x, 0.55 * w.s, w.z), _iq, _is.set(w.s, w.s, w.s));
      mesh.setMatrixAt(i, _im);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [stalks]);
  if (stalks.length === 0) return null;
  return (
    <instancedMesh key={stalks.length} ref={ref} args={[undefined, undefined, stalks.length]} frustumCulled={false}>
      <boxGeometry args={[0.06, 1.1, 0.06]} />
      <meshStandardMaterial color="#d9b44a" roughness={0.9} />
    </instancedMesh>
  );
}

// The scarecrow watching over the wheat.
function Scarecrow({ x, z, rot }: { x: number; z: number; rot: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      <mesh position={[0, 1.0, 0]}>
        <cylinderGeometry args={[0.07, 0.09, 2.0, 6]} />
        <meshStandardMaterial color="#6d4c31" roughness={0.95} />
      </mesh>
      <mesh position={[0, 1.5, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.05, 0.05, 1.7, 6]} />
        <meshStandardMaterial color="#6d4c31" roughness={0.95} />
      </mesh>
      <mesh position={[0, 1.35, 0]}>
        <boxGeometry args={[0.5, 0.7, 0.3]} />
        <meshStandardMaterial color="#a8563e" roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.95, 0]}>
        <sphereGeometry args={[0.22, 10, 10]} />
        <meshStandardMaterial color="#e8d5a8" roughness={0.9} />
      </mesh>
      <mesh position={[0, 2.16, 0]}>
        <coneGeometry args={[0.32, 0.3, 8]} />
        <meshStandardMaterial color="#c9a54a" roughness={0.95} />
      </mesh>
    </group>
  );
}

// A hot-air balloon drifting a slow, high circle over the world.
function Balloon({ extent }: { extent: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame((state) => {
    const grp = g.current;
    if (!grp) return;
    const t = state.clock.elapsedTime * 0.018 + 2;
    const r = extent * 0.55;
    grp.position.set(Math.cos(t) * r, 34 + Math.sin(state.clock.elapsedTime * 0.3) * 1.6, Math.sin(t) * r);
  });
  return (
    <group ref={g}>
      <mesh>
        <sphereGeometry args={[3.2, 16, 16]} />
        <meshStandardMaterial color="#d95f4a" roughness={0.7} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} rotation={[0, (i * Math.PI) / 2 + 0.4, 0]}>
          <sphereGeometry args={[3.22, 16, 16, -0.35, 0.7]} />
          <meshStandardMaterial color={i % 2 ? "#f0e0c0" : "#e8a83c"} roughness={0.7} />
        </mesh>
      ))}
      <mesh position={[0, -3.4, 0]}>
        <coneGeometry args={[1.15, 1.6, 8]} />
        <meshStandardMaterial color="#b8503c" roughness={0.8} />
      </mesh>
      <mesh position={[0, -4.9, 0]}>
        <boxGeometry args={[1.3, 0.95, 1.3]} />
        <meshStandardMaterial color="#8a6240" roughness={0.95} />
      </mesh>
      {[[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]].map(([rx, rz], i) => (
        <mesh key={i} position={[rx, -4.15, rz]}>
          <cylinderGeometry args={[0.02, 0.02, 1.0, 4]} />
          <meshStandardMaterial color="#4a3a28" roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

// A deer grazing the far meadows — wanders slowly, and bolts if someone
// sprints at it. Calm ones just lift their head and watch you pass.
function Deer({ home, playerPosRef }: { home: { x: number; z: number }; playerPosRef?: React.RefObject<{ x: number; z: number }> }) {
  const g = useRef<THREE.Group>(null);
  const st = useRef({ x: home.x, z: home.z, tx: home.x, tz: home.z, ry: 0, flee: 0, graze: 2 });
  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = st.current;
    const grp = g.current;
    if (!grp) return;
    const p = playerPosRef?.current;
    if (p) {
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < 5.5 && s.flee <= 0) {
        // Startled — bolt directly away.
        s.flee = 2.2;
        const away = Math.atan2(s.x - p.x, s.z - p.z);
        s.tx = s.x + Math.sin(away) * 26;
        s.tz = s.z + Math.cos(away) * 26;
      }
    }
    const speed = s.flee > 0 ? 7.5 : 0.9;
    if (s.flee > 0) s.flee -= dt;
    const dx = s.tx - s.x;
    const dz = s.tz - s.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.8) {
      s.graze -= dt;
      if (s.graze <= 0) {
        s.graze = 3 + Math.random() * 5;
        const a = Math.random() * Math.PI * 2;
        s.tx = home.x + Math.cos(a) * (4 + Math.random() * 9);
        s.tz = home.z + Math.sin(a) * (4 + Math.random() * 9);
      }
    } else {
      s.x += (dx / dist) * speed * dt;
      s.z += (dz / dist) * speed * dt;
      s.ry = Math.atan2(dx, dz);
    }
    grp.position.set(s.x, 0, s.z);
    grp.rotation.y = s.ry;
    // grazing head-bob
    const head = grp.children[4]; // the neck+head group in the v2 body
    if (head) head.rotation.x = dist < 0.8 && s.flee <= 0 ? 0.7 + Math.sin(state.clock.elapsedTime * 1.1) * 0.12 : 0;
  });
  return (
    <group ref={g}>
      {/* body — deep chest, slimmer haunch, white rump */}
      <mesh position={[0, 0.8, -0.05]} castShadow>
        <boxGeometry args={[0.52, 0.5, 1.05]} />
        <meshStandardMaterial color="#a97e52" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.74, 0.42]} castShadow>
        <boxGeometry args={[0.46, 0.56, 0.36]} />
        <meshStandardMaterial color="#b48a5c" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.84, -0.56]}>
        <boxGeometry args={[0.4, 0.34, 0.06]} />
        <meshStandardMaterial color="#efe6d2" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.98, -0.6]} rotation={[0.5, 0, 0]}>
        <capsuleGeometry args={[0.05, 0.14, 4, 6]} />
        <meshStandardMaterial color="#e8dcc8" roughness={0.9} />
      </mesh>
      {/* neck + head group (bobbed while grazing) */}
      <group position={[0, 1.05, 0.55]}>
        <mesh position={[0, 0.05, 0.02]} rotation={[0.5, 0, 0]} castShadow>
          <boxGeometry args={[0.2, 0.42, 0.22]} />
          <meshStandardMaterial color="#b48a5c" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.3, 0.14]} castShadow>
          <boxGeometry args={[0.26, 0.26, 0.4]} />
          <meshStandardMaterial color="#b48a5c" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.24, 0.38]}>
          <boxGeometry args={[0.16, 0.16, 0.14]} />
          <meshStandardMaterial color="#c49a6c" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.26, 0.46]}>
          <boxGeometry args={[0.07, 0.06, 0.03]} />
          <meshStandardMaterial color="#2e241a" roughness={0.8} />
        </mesh>
        {[-0.1, 0.1].map((ex) => (
          <mesh key={ex} position={[ex, 0.34, 0.31]}>
            <sphereGeometry args={[0.03, 6, 6]} />
            <meshStandardMaterial color="#241c12" roughness={0.6} />
          </mesh>
        ))}
        {[-0.14, 0.14].map((ex) => (
          <mesh key={`e${ex}`} position={[ex, 0.46, 0.05]} rotation={[0, 0, ex * 4]}>
            <coneGeometry args={[0.055, 0.16, 5]} />
            <meshStandardMaterial color="#a97e52" roughness={0.9} />
          </mesh>
        ))}
        {[-0.1, 0.1].map((ax) => (
          <group key={`a${ax}`} position={[ax, 0.44, 0.02]}>
            <mesh rotation={[0, 0, ax * 3.2]}>
              <cylinderGeometry args={[0.024, 0.034, 0.4, 5]} />
              <meshStandardMaterial color="#6d4c31" roughness={0.95} />
            </mesh>
            <mesh position={[ax * 1.6, 0.2, 0.02]} rotation={[0, 0, ax * 6.5]}>
              <cylinderGeometry args={[0.018, 0.024, 0.24, 4]} />
              <meshStandardMaterial color="#6d4c31" roughness={0.95} />
            </mesh>
            <mesh position={[ax * 0.9, 0.16, 0.1]} rotation={[0.7, 0, ax * 2.5]}>
              <cylinderGeometry args={[0.015, 0.02, 0.18, 4]} />
              <meshStandardMaterial color="#7a5a3c" roughness={0.95} />
            </mesh>
          </group>
        ))}
      </group>
      {/* slender legs with dark hooves */}
      {[[-0.16, 0.35], [0.16, 0.35], [-0.16, -0.42], [0.16, -0.42]].map(([lx, lz], i) => (
        <group key={i} position={[lx, 0, lz]}>
          <mesh position={[0, 0.34, 0]} castShadow>
            <cylinderGeometry args={[0.045, 0.055, 0.62, 5]} />
            <meshStandardMaterial color="#8a6a44" roughness={0.9} />
          </mesh>
          <mesh position={[0, 0.04, 0]}>
            <cylinderGeometry args={[0.05, 0.055, 0.08, 5]} />
            <meshStandardMaterial color="#3a2c1e" roughness={0.85} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// The plaza job board — a wooden noticeboard where the network's REAL open
// tasks are pinned (press E to read them). Stands in the grass ring just off
// the plaza, facing the monument.
function BidBoardStand({ x, z, ry }: { x: number; z: number; ry: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, ry, 0]}>
      {[-0.95, 0.95].map((px) => (
        <mesh key={px} position={[px, 1.05, 0]}>
          <boxGeometry args={[0.16, 2.1, 0.16]} />
          <meshStandardMaterial color="#6d4c31" roughness={0.95} />
        </mesh>
      ))}
      <mesh position={[0, 1.45, 0]}>
        <boxGeometry args={[2.3, 1.25, 0.1]} />
        <meshStandardMaterial color="#8a6240" roughness={0.9} />
      </mesh>
      {/* pinned notes */}
      {([[-0.7, 1.7, -0.06], [0, 1.62, 0.04], [0.68, 1.72, -0.03], [-0.4, 1.2, 0.05], [0.35, 1.22, -0.04]] as const).map(([nx, ny, rz], i) => (
        <group key={i} position={[nx, ny, 0.07]} rotation={[0, 0, rz]}>
          <mesh>
            <planeGeometry args={[0.42, 0.34]} />
            <meshStandardMaterial color={["#f2e8d0", "#e8f0d8", "#f0e0e0", "#f2e8d0", "#e0e8f0"][i]} roughness={0.9} />
          </mesh>
          {/* scribbled lines — a headline and a couple of body rows */}
          <mesh position={[0, 0.08, 0.005]}>
            <planeGeometry args={[0.3, 0.035]} />
            <meshStandardMaterial color="#4a4038" roughness={1} />
          </mesh>
          {[0.01, -0.05, -0.11].map((ly, k) => (
            <mesh key={k} position={[(k % 2 ? -0.02 : 0.02), ly, 0.005]}>
              <planeGeometry args={[0.24 - k * 0.04, 0.018]} />
              <meshStandardMaterial color="#6a6258" roughness={1} />
            </mesh>
          ))}
          <mesh position={[0, 0.14, 0.01]}>
            <sphereGeometry args={[0.025, 6, 6]} />
            <meshStandardMaterial color="#c0392b" roughness={0.5} />
          </mesh>
        </group>
      ))}
      {/* little shingle roof — seated on the post tops with struts, not floating */}
      <mesh position={[0, 2.16, 0.1]} rotation={[0.5, 0, 0]}>
        <boxGeometry args={[2.5, 0.06, 0.55]} />
        <meshStandardMaterial color="#5b6b4a" roughness={0.9} />
      </mesh>
      {[-0.95, 0.95].map((px) => (
        <mesh key={`s${px}`} position={[px, 2.09, 0.1]} rotation={[0.5, 0, 0]}>
          <boxGeometry args={[0.14, 0.1, 0.5]} />
          <meshStandardMaterial color="#6d4c31" roughness={0.95} />
        </mesh>
      ))}
      <Signboard text="JOB BOARD" position={[0, 2.6, 0]} scale={3.4} />
    </group>
  );
}

// A warm lantern by the door of a house whose agent has a LIVE bid on the job
// board — you can spot who's competing for work from across the district.
function BidLantern({ w, rotation }: { w: number; rotation: number }) {
  const df = w / 2;
  const glow = useRef<THREE.MeshStandardMaterial>(null);
  // Candle-like flicker: two incommensurate sine waves so it never loops
  // visibly. Only mounted at bidding houses, so the per-frame cost is tiny.
  useFrame((state) => {
    const m = glow.current;
    if (!m) return;
    const t = state.clock.elapsedTime;
    m.emissiveIntensity = 1.45 + Math.sin(t * 7.3) * 0.25 + Math.sin(t * 11.7 + 1.4) * 0.18;
  });
  return (
    <group rotation={[0, rotation, 0]}>
      <group position={[-(w * 0.36), 0, df + 1.15]}>
        <mesh position={[0, 0.55, 0]}>
          <cylinderGeometry args={[0.045, 0.06, 1.1, 6]} />
          <meshStandardMaterial color="#4a3a28" roughness={0.9} />
        </mesh>
        <mesh position={[0, 1.18, 0]}>
          <boxGeometry args={[0.22, 0.28, 0.22]} />
          <meshStandardMaterial color="#2e2a22" roughness={0.8} />
        </mesh>
        <mesh position={[0, 1.17, 0]}>
          <sphereGeometry args={[0.085, 8, 8]} />
          <meshStandardMaterial ref={glow} color="#ffd27a" emissive="#ffb84a" emissiveIntensity={1.6} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

// A daily gift chest beside an active agent's front door — a small thank-you
// for visiting (press E to open, once per house per day). The lid swings open
// once claimed; the latch glows softly while a gift is still waiting.
function GiftChest({ w, rotation, opened }: { w: number; rotation: number; opened: boolean }) {
  const df = w / 2;
  return (
    <group rotation={[0, rotation, 0]}>
      <group position={[w * 0.36, 0, df + 0.55]}>
        <mesh position={[0, 0.2, 0]}>
          <boxGeometry args={[0.62, 0.38, 0.44]} />
          <meshStandardMaterial color="#6d4c31" roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.2, 0]}>
          <boxGeometry args={[0.64, 0.09, 0.46]} />
          <meshStandardMaterial color="#d9a94a" metalness={0.5} roughness={0.4} />
        </mesh>
        {/* lid — hinged at the back edge */}
        <group position={[0, 0.39, -0.22]} rotation={[opened ? -1.9 : 0, 0, 0]}>
          <mesh position={[0, 0.07, 0.22]}>
            <boxGeometry args={[0.62, 0.15, 0.44]} />
            <meshStandardMaterial color="#8a6240" roughness={0.85} />
          </mesh>
          <mesh position={[0, 0.1, 0.22]}>
            <boxGeometry args={[0.64, 0.06, 0.46]} />
            <meshStandardMaterial color="#d9a94a" metalness={0.5} roughness={0.4} />
          </mesh>
        </group>
        {!opened && (
          <mesh position={[0, 0.32, 0.235]}>
            <boxGeometry args={[0.12, 0.14, 0.04]} />
            <meshStandardMaterial color="#e9c05e" metalness={0.6} roughness={0.3} emissive="#e9c05e" emissiveIntensity={0.35} />
          </mesh>
        )}
      </group>
    </group>
  );
}

// Memoized: the world is a huge R3F subtree, and the HUD above it re-renders
// constantly (view toggles, proximity prompts, toasts). Without memo every one
// of those re-diffed thousands of world elements — the source of the hitch
// when switching camera views. With it, the world only re-renders when its
// actual inputs change (plots, chest claims, a knock, bid lanterns).
// ── Hall of Fame ──────────────────────────────────────────────────────────────
// A memorial garden generated from live data: the network's top agents by
// reputation get a bronze statue with their name. Earn your way in and the
// town builds you a monument — lose the spot and it goes to someone else.

function worldHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function StatuePlaque({ name, rank }: { name: string; rank: number }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#2e2417";
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = "#c9a24b";
    ctx.lineWidth = 5;
    ctx.strokeRect(8, 8, 240, 112);
    ctx.textAlign = "center";
    ctx.fillStyle = "#e8c56a";
    ctx.font = "bold 26px Georgia, serif";
    ctx.fillText(`No. ${rank}`, 128, 44);
    ctx.fillStyle = "#f3e3b8";
    ctx.font = "bold 22px Georgia, serif";
    const label = name.length > 20 ? `${name.slice(0, 19)}…` : name;
    ctx.fillText(label, 128, 82);
    ctx.fillStyle = "#c9a24b";
    ctx.font = "13px Georgia, serif";
    ctx.fillText("HALL OF FAME", 128, 108);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, [name, rank]);
  return (
    // Mounted plate: a bronze backing box proud of the column face, with the
    // engraved canvas on its front — reads as a real plaque, never sunken.
    <group position={[0, 0.88, 0.79]}>
      <mesh castShadow>
        <boxGeometry args={[1.26, 0.68, 0.08]} />
        <meshStandardMaterial color="#6f5526" metalness={0.5} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0, 0.045]}>
        <planeGeometry args={[1.14, 0.57]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}

const STATUE_BRONZE = { color: "#9a7434", metalness: 0.55, roughness: 0.45 } as const;
const STATUE_BRONZE_DARK = { color: "#6f5526", metalness: 0.5, roughness: 0.55 } as const;
// Podium trim per rank: gold, silver, bronze.
const RANK_TRIM = ["#e2b23c", "#c8ccd4", "#b0793f"];

function AgentStatue({ name, rank, dx, dz, s = 1 }: { name: string; rank: number; dx: number; dz: number; s?: number }) {
  // The champion salutes the town; the runners-up stand at ease.
  const raised = rank === 1;
  const trim = RANK_TRIM[rank - 1] ?? RANK_TRIM[2];
  return (
    <group position={[dx, 0, dz]}>
      {/* three-tier stone pedestal: slab → molding → column → rank trim → cap */}
      <mesh position={[0, 0.15, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.4, 0.3, 2.4]} />
        <meshStandardMaterial color="#948b7a" roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.36, 0]}>
        <boxGeometry args={[1.95, 0.12, 1.95]} />
        <meshStandardMaterial color="#b9b0a0" roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.83, 0]} castShadow>
        <boxGeometry args={[1.5, 0.82, 1.5]} />
        <meshStandardMaterial color="#a89f8d" roughness={0.95} />
      </mesh>
      <mesh position={[0, 1.28, 0]}>
        <boxGeometry args={[1.56, 0.07, 1.56]} />
        <meshStandardMaterial color={trim} metalness={0.55} roughness={0.4} />
      </mesh>
      <mesh position={[0, 1.38, 0]} castShadow>
        <boxGeometry args={[1.75, 0.12, 1.75]} />
        <meshStandardMaterial color="#b9b0a0" roughness={0.95} />
      </mesh>
      <StatuePlaque name={name} rank={rank} />
      {/* the bronze figure — boots, belt, chest emblem, shoulders, laurel */}
      <group position={[0, 1.44, 0]} scale={0.78 * s}>
        <mesh position={[0, 0.05, 0]} castShadow>
          <cylinderGeometry args={[0.6, 0.66, 0.1, 12]} />
          <meshStandardMaterial {...STATUE_BRONZE_DARK} />
        </mesh>
        {[-0.2, 0.2].map((x) => (
          <mesh key={`b${x}`} position={[x, 0.21, 0.03]} castShadow>
            <boxGeometry args={[0.4, 0.22, 0.52]} />
            <meshStandardMaterial {...STATUE_BRONZE_DARK} />
          </mesh>
        ))}
        {[-0.2, 0.2].map((x) => (
          <mesh key={`l${x}`} position={[x, 0.68, 0]} castShadow>
            <boxGeometry args={[0.34, 0.72, 0.4]} />
            <meshStandardMaterial {...STATUE_BRONZE} />
          </mesh>
        ))}
        <mesh position={[0, 1.1, 0]}>
          <boxGeometry args={[1.0, 0.14, 0.52]} />
          <meshStandardMaterial {...STATUE_BRONZE_DARK} />
        </mesh>
        <mesh position={[0, 1.55, 0]} castShadow>
          <boxGeometry args={[0.95, 0.85, 0.48]} />
          <meshStandardMaterial {...STATUE_BRONZE} />
        </mesh>
        {/* the network's emblem on the chest */}
        <mesh position={[0, 1.62, 0.26]}>
          <boxGeometry args={[0.28, 0.28, 0.06]} />
          <meshStandardMaterial color={trim} metalness={0.6} roughness={0.35} />
        </mesh>
        {[-0.62, 0.62].map((x) => (
          <mesh key={`s${x}`} position={[x, 1.9, 0]} castShadow>
            <boxGeometry args={[0.36, 0.18, 0.46]} />
            <meshStandardMaterial {...STATUE_BRONZE_DARK} />
          </mesh>
        ))}
        <mesh position={[-0.62, 1.5, 0]} castShadow>
          <boxGeometry args={[0.26, 0.75, 0.4]} />
          <meshStandardMaterial {...STATUE_BRONZE} />
        </mesh>
        {raised ? (
          <mesh position={[0.7, 2.02, 0]} rotation={[0, 0, -0.5]} castShadow>
            <boxGeometry args={[0.26, 0.78, 0.4]} />
            <meshStandardMaterial {...STATUE_BRONZE} />
          </mesh>
        ) : (
          <mesh position={[0.62, 1.5, 0]} castShadow>
            <boxGeometry args={[0.26, 0.75, 0.4]} />
            <meshStandardMaterial {...STATUE_BRONZE} />
          </mesh>
        )}
        <mesh position={[0, 2.04, 0]}>
          <boxGeometry args={[0.3, 0.16, 0.3]} />
          <meshStandardMaterial {...STATUE_BRONZE} />
        </mesh>
        <mesh position={[0, 2.46, 0]} castShadow>
          <boxGeometry args={[0.72, 0.72, 0.72]} />
          <meshStandardMaterial {...STATUE_BRONZE} />
        </mesh>
        <mesh position={[0, 2.42, 0.38]}>
          <boxGeometry args={[0.1, 0.16, 0.08]} />
          <meshStandardMaterial {...STATUE_BRONZE} />
        </mesh>
        <mesh position={[0, 2.62, 0.34]}>
          <boxGeometry args={[0.58, 0.08, 0.12]} />
          <meshStandardMaterial {...STATUE_BRONZE_DARK} />
        </mesh>
        {/* laurel wreath with leaves */}
        <mesh position={[0, 2.82, 0]}>
          <cylinderGeometry args={[0.4, 0.42, 0.1, 10]} />
          <meshStandardMaterial color="#c9a24b" metalness={0.6} roughness={0.35} />
        </mesh>
        {Array.from({ length: 6 }, (_, i) => {
          const a = (i / 6) * Math.PI * 2;
          return (
            <mesh key={`lf${i}`} position={[Math.cos(a) * 0.42, 2.86, Math.sin(a) * 0.42]} rotation={[0.3, -a, 0]}>
              <boxGeometry args={[0.07, 0.16, 0.03]} />
              <meshStandardMaterial color="#d9b45a" metalness={0.55} roughness={0.4} />
            </mesh>
          );
        })}
      </group>
      {/* the name floats WELL above the wreath — readable from any angle */}
      <Signboard text={`#${rank} ${name}`} position={[0, 4.9 + s * 0.7, 0]} scale={3.4} />
    </group>
  );
}

function HallOfFame({ top }: { top: { name: string; rank: number }[] }) {
  const spots = [
    { dx: 0, dz: -1.0, s: 1.15 },
    { dx: -3.5, dz: 0.8, s: 1 },
    { dx: 3.5, dz: 0.8, s: 1 },
  ];
  return (
    <group>
      {/* paving: base disc, dark rim, raised centre medallion, radial seams */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
        <circleGeometry args={[6.6, 32]} />
        <meshStandardMaterial color="#b7afa0" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[6.0, 6.6, 32]} />
        <meshStandardMaterial color="#8f8778" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
        <circleGeometry args={[2.0, 24]} />
        <meshStandardMaterial color="#cfc7b4" roughness={0.95} />
      </mesh>
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2 + 0.2;
        return (
          <mesh key={`seam${i}`} position={[Math.cos(a) * 4.1, 0.032, Math.sin(a) * 4.1]} rotation={[0, Math.atan2(Math.cos(a), Math.sin(a)), 0]}>
            <boxGeometry args={[0.07, 0.012, 4.0]} />
            <meshStandardMaterial color="#948b7a" roughness={1} />
          </mesh>
        );
      })}
      {/* hedge crescent shelters the back of the garden */}
      {Array.from({ length: 7 }, (_, i) => {
        const th = (i - 3) * 0.34;
        return (
          <mesh key={i} position={[Math.sin(th) * 7.0, 0.55, -Math.cos(th) * 7.0]} scale={[1, 0.75, 1]} castShadow>
            <sphereGeometry args={[0.95, 8, 6]} />
            <meshStandardMaterial color="#3f7a42" roughness={0.95} />
          </mesh>
        );
      })}
      {/* blossom trees frame the back corners */}
      {[-5.4, 5.4].map((tx) => (
        <group key={`t${tx}`} position={[tx, 0, -3.6]}>
          <mesh position={[0, 0.55, 0]} castShadow>
            <cylinderGeometry args={[0.13, 0.17, 1.1, 7]} />
            <meshStandardMaterial color="#6b4a30" roughness={0.95} />
          </mesh>
          <mesh position={[0, 1.45, 0]} castShadow>
            <sphereGeometry args={[0.75, 8, 7]} />
            <meshStandardMaterial color="#f4a6c0" roughness={0.9} />
          </mesh>
          <mesh position={[0.35, 1.05, 0.2]}>
            <sphereGeometry args={[0.45, 7, 6]} />
            <meshStandardMaterial color="#f8bcd0" roughness={0.9} />
          </mesh>
        </group>
      ))}
      {top.map((t, i) => (
        <AgentStatue key={t.name} name={t.name} rank={t.rank} dx={spots[i].dx} dz={spots[i].dz} s={spots[i].s} />
      ))}
      {/* lanterns glow at the rim after dark */}
      {[[-5.6, 1.8], [5.6, 1.8], [-2.6, -5.6], [2.6, -5.6]].map(([lx, lz], i) => (
        <group key={`ln${i}`} position={[lx, 0, lz]}>
          <mesh position={[0, 0.75, 0]} castShadow>
            <cylinderGeometry args={[0.05, 0.07, 1.5, 6]} />
            <meshStandardMaterial color="#4a4038" roughness={0.85} />
          </mesh>
          <mesh position={[0, 1.6, 0]}>
            <boxGeometry args={[0.26, 0.3, 0.26]} />
            <meshStandardMaterial color="#ffd98a" emissive="#e8a94a" emissiveIntensity={0.65} roughness={0.5} />
          </mesh>
          <mesh position={[0, 1.8, 0]}>
            <coneGeometry args={[0.22, 0.16, 4]} />
            <meshStandardMaterial color="#3a332c" roughness={0.9} />
          </mesh>
        </group>
      ))}
      {/* banner poles flank the entrance */}
      {[-1.7, 1.7].map((bx) => (
        <group key={`bp${bx}`} position={[bx, 0, 6.0]}>
          <mesh position={[0, 1.7, 0]} castShadow>
            <cylinderGeometry args={[0.05, 0.07, 3.4, 6]} />
            <meshStandardMaterial color="#5a4a38" roughness={0.9} />
          </mesh>
          <mesh position={[0, 3.44, 0]}>
            <sphereGeometry args={[0.08, 6, 6]} />
            <meshStandardMaterial color="#e2b23c" metalness={0.5} roughness={0.4} />
          </mesh>
          <mesh position={[bx > 0 ? -0.38 : 0.38, 3.0, 0]}>
            <boxGeometry args={[0.72, 0.44, 0.03]} />
            <meshStandardMaterial color="#2dd4bf" roughness={0.85} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
      {/* flower beds soften the stone; benches sit back from the statues */}
      {[[-2.3, 3.6], [2.3, 3.6], [-5.2, -1.6], [5.2, -1.6], [0, -4.6]].map(([fx, fz], i) => (
        <Flowers key={`hf${i}`} position={[fx, 0, fz]} />
      ))}
      {[-3.6, 3.6].map((bx) => (
        <Bench key={bx} position={[bx, 0, 5.8]} rotation={Math.PI} />
      ))}
      {/* the garden sign stands aside — never blocking the view of the statues */}
      <Signpost text="Hall of Fame" position={[6.4, 0, 2.4]} />
    </group>
  );
}

// ── Staffed market stalls ─────────────────────────────────────────────────────
// The plaza stalls aren't set dressing: the week's busiest agents stand at
// them with their real listed prices on the awning.

const VENDOR_SHIRTS = ["#c05f4a", "#3e7cb1", "#7a9a3f", "#b08b3e", "#7a5aa0"];
const VENDOR_SKINS = ["#e8b98a", "#d9a06a", "#c78a56", "#f0c9a0"];

function StallVendor({ name }: { name: string }) {
  const h = worldHash(name);
  const shirt = VENDOR_SHIRTS[h % VENDOR_SHIRTS.length];
  const skin = VENDOR_SKINS[(h >> 3) % VENDOR_SKINS.length];
  return (
    <group position={[0, 0, -1.35]} scale={0.74}>
      {[-0.2, 0.2].map((x) => (
        <mesh key={x} position={[x, 0.4, 0]} castShadow>
          <boxGeometry args={[0.36, 0.8, 0.42]} />
          <meshStandardMaterial color="#4a4038" roughness={0.9} />
        </mesh>
      ))}
      <mesh position={[0, 1.25, 0]} castShadow>
        <boxGeometry args={[0.95, 0.9, 0.48]} />
        <meshStandardMaterial color={shirt} roughness={0.85} />
      </mesh>
      {/* apron */}
      <mesh position={[0, 1.1, 0.26]}>
        <boxGeometry args={[0.7, 0.62, 0.03]} />
        <meshStandardMaterial color="#e8e2d2" roughness={0.9} />
      </mesh>
      {[-0.61, 0.61].map((x) => (
        <mesh key={x} position={[x, 1.28, 0]} castShadow>
          <boxGeometry args={[0.26, 0.78, 0.4]} />
          <meshStandardMaterial color={shirt} roughness={0.85} />
        </mesh>
      ))}
      <mesh position={[0, 2.1, 0]} castShadow>
        <boxGeometry args={[0.8, 0.8, 0.8]} />
        <meshStandardMaterial color={skin} roughness={0.95} />
      </mesh>
      {/* eyes, so they read as a person even at range */}
      {[-0.17, 0.17].map((x) => (
        <mesh key={x} position={[x, 2.14, 0.41]}>
          <boxGeometry args={[0.12, 0.14, 0.02]} />
          <meshStandardMaterial color="#2a2320" roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

function StallSign({ name, price }: { name: string; price: string | null }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 96;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#f6efdd";
    ctx.fillRect(0, 0, 512, 96);
    ctx.strokeStyle = "#7a4a24";
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, 500, 84);
    ctx.textAlign = "center";
    ctx.fillStyle = "#3a2c18";
    ctx.font = "bold 34px Georgia, serif";
    const label = name.length > 22 ? `${name.slice(0, 21)}…` : name;
    ctx.fillText(label, 256, 42);
    ctx.fillStyle = "#0f766e";
    ctx.font = "bold 26px Georgia, serif";
    ctx.fillText(price ? `hire · ${price}` : "hire · open terms", 256, 76);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, [name, price]);
  return (
    <mesh position={[0, 1.62, 1.02]} rotation={[0.12, 0, 0]}>
      <planeGeometry args={[2.2, 0.42]} />
      <meshBasicMaterial map={tex} toneMapped={false} />
    </mesh>
  );
}

// The plaza world-map board — a painted chart of THIS generated town, drawn
// from the exact layout data the world was built from, so it can never drift
// from reality. E opens the interactive locate panel.
function MapBoardStand({ x, z, ry, extent, streetAngles, houses, landmarks }: {
  x: number; z: number; ry: number; extent: number; streetAngles: number[];
  houses: { x: number; z: number }[]; landmarks: WorldLandmarks;
}) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    const k = 112 / extent;
    const px = (wx: number) => 128 + wx * k;
    const pz = (wz: number) => 128 + wz * k;
    ctx.fillStyle = "#efe3c8";
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = "#7a5a34";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 250, 250);
    ctx.fillStyle = "#cfe3b4";
    ctx.beginPath();
    ctx.arc(128, 128, extent * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#d9c9a0";
    ctx.lineWidth = 4;
    for (const a of streetAngles) {
      ctx.beginPath();
      ctx.moveTo(px(Math.cos(a) * 11), pz(Math.sin(a) * 11));
      ctx.lineTo(px(Math.cos(a) * extent * 0.82), pz(Math.sin(a) * extent * 0.82));
      ctx.stroke();
    }
    ctx.fillStyle = "#7ec3d8";
    for (const p of landmarks.ponds) {
      ctx.beginPath();
      ctx.arc(px(p.x), pz(p.z), 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "#7ec3d8";
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(128, 128, landmarks.riverArc.r * k, landmarks.riverArc.a0, landmarks.riverArc.a0 + landmarks.riverArc.span);
    ctx.stroke();
    ctx.fillStyle = "#8a5a3c";
    for (const h of houses) ctx.fillRect(px(h.x) - 1.5, pz(h.z) - 1.5, 3, 3);
    ctx.font = "16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("\u2B50", 128, 128);
    if (landmarks.farm) ctx.fillText("\uD83C\uDF3E", px(landmarks.farm.x), pz(landmarks.farm.z));
    if (landmarks.hof) ctx.fillText("\uD83C\uDFDB", px(landmarks.hof.x), pz(landmarks.hof.z));
    ctx.fillText("\u26F2", px(landmarks.garden.x), pz(landmarks.garden.z));
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, [extent, streetAngles, houses, landmarks]);
  return (
    <group position={[x, 0, z]} rotation={[0, ry, 0]}>
      {[-0.85, 0.85].map((sx) => (
        <mesh key={sx} position={[sx, 1.0, 0]} castShadow>
          <cylinderGeometry args={[0.07, 0.09, 2.0, 6]} />
          <meshStandardMaterial color="#6b4a2a" roughness={0.9} />
        </mesh>
      ))}
      <mesh position={[0, 1.55, 0.02]} castShadow>
        <boxGeometry args={[1.9, 1.5, 0.1]} />
        <meshStandardMaterial color="#8a6240" roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.55, 0.08]}>
        <planeGeometry args={[1.7, 1.3]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      <mesh position={[0, 2.42, 0]} rotation={[0.18, 0, 0]} castShadow>
        <boxGeometry args={[2.1, 0.06, 0.5]} />
        <meshStandardMaterial color="#5a4a38" roughness={0.9} />
      </mesh>
      <Signboard text="WORLD MAP" position={[0, 2.75, 0]} scale={3.2} />
    </group>
  );
}

export const OpenWorld = memo(function OpenWorld({
  plots,
  lowPower = false,
  onSolids,
  onBuildings,
  onFishSpots,
  onBenches,
  onGatherSpots,
  onBouncePads,
  bounceFxRef,
  onExtent,
  playerPosRef,
  animalsRef,
  onHenCaught,
  onNearPet,
  trophyIds,
  trophyRarities,
  onChests,
  openedChestIds,
  knockId,
  onBoard,
  bidderIds,
  onDesk,
  stallStaff,
  onMapBoard,
  onLandmarks,
  showTitle = true,
}: {
  plots: OpenPlot[];
  lowPower?: boolean;
  onSolids?: (s: Collider[]) => void;
  onBuildings?: (b: WorldBuilding[]) => void;
  onFishSpots?: (s: FishSpot[]) => void;
  onBenches?: (b: BenchSpot[]) => void;
  onGatherSpots?: (s: GatherSpot[]) => void;
  onBouncePads?: (p: { x: number; z: number; r: number }[]) => void;
  bounceFxRef?: React.RefObject<{ x: number; z: number; t: number } | null>;
  onExtent?: (r: number) => void;
  playerPosRef?: React.RefObject<{ x: number; z: number }>;
  animalsRef?: React.RefObject<{ x: number; z: number }[]>;
  onHenCaught?: () => void;
  onNearPet?: (near: boolean) => void;
  /** Houses owned by the connected wallet — they get a trophy shelf. */
  trophyIds?: Set<string>;
  /** Rarities of the owner's best inventory items, rarest first. */
  trophyRarities?: Rarity[];
  /** Daily gift chest positions at active houses (world coords). */
  onChests?: (c: { id: string; x: number; z: number }[]) => void;
  /** Chests already opened today — rendered with the lid up. */
  openedChestIds?: Set<string>;
  /** A knock in progress — that house's door swings open (the greeter figure
      itself is rendered by the caller, which owns the avatar system). */
  knockId?: string | null;
  /** Where the plaza job board stands (world coords + facing). */
  onBoard?: (b: { x: number; z: number; ry: number }) => void;
  /** Agents with a LIVE bid on the job board — their houses get a lantern. */
  bidderIds?: Set<string>;
  /** Where the pipeline desk stands (world coords + facing). */
  onDesk?: (d: { x: number; z: number; ry: number }) => void;
  /** The week's busiest agents — they staff the plaza market stalls. */
  stallStaff?: StallStaffAgent[];
  /** Where the plaza world-map board stands (world coords + facing). */
  onMapBoard?: (b: { x: number; z: number; ry: number }) => void;
  /** Landmark coordinates for the map overlay. */
  onLandmarks?: (l: WorldLandmarks) => void;
  showTitle?: boolean;
}) {
  const layout = useMemo(() => {
    // Group agents by district. Each district is a STREET radiating out from the
    // hub: houses line both sides of a central dirt path, facing it, offset far
    // enough that the path never runs through a house. Districts are spaced
    // symmetrically around a ring so the whole world is balanced.
    const byDistrict = new Map<string, OpenPlot[]>();
    for (const p of plots) {
      const arr = byDistrict.get(p.district);
      if (arr) arr.push(p);
      else byDistrict.set(p.district, [p]);
    }
    const names = [...byDistrict.keys()].sort();
    const N = names.length;
    const LANE = 9.5; // house-centre distance from the street centreline
    const ROW = 16; // spacing between consecutive houses along the street
    const STREET_W = 5; // path width
    const ranksOf = (c: number) => Math.max(1, Math.ceil(c / 2));
    let maxHalfLen = 0;
    for (const n of names) maxHalfLen = Math.max(maxHalfLen, ((ranksOf(byDistrict.get(n)!.length) - 1) / 2) * ROW);
    const districtRadius = Math.hypot(maxHalfLen + 4, LANE + 4);
    const ringBySpacing = N > 1 ? (2 * districtRadius + 20) / (2 * Math.sin(Math.PI / N)) : 0;
    const RING = N <= 1 ? 0 : Math.max(58, maxHalfLen + 26, ringBySpacing);

    // Every street leaves the plaza at one of these angles. All plaza furniture
    // anchors to the MIDPOINTS between streets so nothing sits in a path mouth.
    const streetAngles = names.map((_, i) => -Math.PI / 2 + (i / Math.max(1, N)) * Math.PI * 2);
    const mids = N > 0 ? streetAngles.map((a) => a + Math.PI / Math.max(1, N)) : [0, 1, 2, 3, 4, 5].map((i) => (i / 6) * Math.PI * 2);
    const L = mids.length;
    const gap = (Math.PI * 2) / Math.max(1, L);
    // Benches sit EXACTLY on the street-gap midlines — as far as possible from
    // every walkway lane crossing the plaza. Duplicate slots (few districts)
    // shift within their gap, never toward a street.
    const benchAngles: number[] = [];
    for (let i = 0; i < 4; i++) {
      const base = mids[Math.floor((i * L) / 4) % L];
      benchAngles.push(benchAngles.some((b) => Math.abs(b - base) < 0.01) ? base + gap * 0.3 : base);
    }
    // Stalls take midlines no bench uses, falling back to a safe in-gap offset.
    const freeMids = mids.filter((m) => !benchAngles.some((b) => Math.abs(b - m) < 0.01));
    const stallAngles =
      freeMids.length >= 2
        ? [freeMids[0], freeMids[Math.floor(freeMids.length / 2)]]
        : [mids[0] + gap * 0.3, mids[Math.floor(L / 2) % L] + gap * 0.3];
    const AWNINGS = ["#2dd4bf", "#e07a5f"];
    const furniture = {
      // EVERY street gap gets a lamp — a fixed cap of 8 left dark, ropeless
      // gaps in the ring the moment the town grew past 8 districts.
      lamps: mids.map((a) => ({ x: Math.cos(a) * 9.6, z: Math.sin(a) * 9.6 })),
      benches: benchAngles.map((a) => ({ x: Math.cos(a) * 6.9, z: Math.sin(a) * 6.9, ry: Math.atan2(-Math.cos(a), -Math.sin(a)) })),
      stalls: stallAngles.map((a, i) => ({ x: Math.cos(a) * 7.6, z: Math.sin(a) * 7.6, ry: Math.atan2(-Math.cos(a), -Math.sin(a)), awning: AWNINGS[i % 2] })),
      flowers: mids.slice(0, 6).map((a) => ({ x: Math.cos(a + gap * 0.2) * 8.55, z: Math.sin(a + gap * 0.2) * 8.55 })),
    };

    const houses: {
      key: string; name: string; pos: Vec3; w: number; h: number; roofPeak: number; wall: string; roof: string; door: string;
      rot: number; chimney: boolean; radius: number; active: boolean; flair: number;
    }[] = [];
    const paths: { x1: number; z1: number; x2: number; z2: number; w: number; main?: boolean }[] = [];
    const lamps: Vec3[] = [];
    const signs: { text: string; pos: Vec3 }[] = [];
    const chickenCand: { x: number; z: number; rot: number }[] = [];

    names.forEach((name, i) => {
      const angle = -Math.PI / 2 + (i / Math.max(1, N)) * Math.PI * 2;
      const dirx = Math.cos(angle), dirz = Math.sin(angle); // street runs outward
      const perpx = -Math.sin(angle), perpz = Math.cos(angle);
      const cx = dirx * RING, cz = dirz * RING; // district centre on the ring
      const members = byDistrict.get(name)!;
      const ranks = ranksOf(members.length);
      const halfLen = ((ranks - 1) / 2) * ROW;
      // Entrance = inner end of the street (hub side).
      const entrx = cx - dirx * halfLen, entrz = cz - dirz * halfLen;

      // Plaza rim → entrance (starts at the paved plaza edge, not the centre, so
      // no dirt path bleeds across the plaza), and the street strip itself.
      if (RING > 0) paths.push({ x1: dirx * PLAZA_R, z1: dirz * PLAZA_R, x2: entrx, z2: entrz, w: 3.4 });
      const streetLen = (ranks - 1) * ROW + 10;
      paths.push({ x1: cx - dirx * streetLen / 2, z1: cz - dirz * streetLen / 2, x2: cx + dirx * streetLen / 2, z2: cz + dirz * streetLen / 2, w: STREET_W, main: true });

      // Signpost + lamp flanking the street entrance, set well FORWARD of the
      // first houses (toward the hub) so the board never clips a cottage.
      const front = 10;
      const sideOff = STREET_W / 2 + 2.5;
      signs.push({ text: name, pos: [entrx - dirx * front + perpx * sideOff, 0, entrz - dirz * front + perpz * sideOff] });
      lamps.push([entrx - dirx * front - perpx * sideOff, 0, entrz - dirz * front - perpz * sideOff]);

      // Hens pecking about near the signpost (filtered against paths later).
      const dr = mulberry(hashStr(name));
      chickenCand.push(
        { x: entrx - dirx * front + perpx * (sideOff + 2.6), z: entrz - dirz * front + perpz * (sideOff + 2.6), rot: dr() * Math.PI * 2 },
        { x: entrx - dirx * (front + 3.2) + perpx * (sideOff + 1.4), z: entrz - dirz * (front + 3.2) + perpz * (sideOff + 1.4), rot: dr() * Math.PI * 2 },
      );

      members.forEach((p, j) => {
        const sideSign = j % 2 === 0 ? -1 : 1;
        const rank = Math.floor(j / 2);
        const along = rank * ROW;
        const ax = entrx + dirx * along, az = entrz + dirz * along; // point on centreline
        const r = mulberry(hashStr(p.agentId));
        const w = 6 + r() * 0.6;
        const h = 3.2 + Math.min(p.size, 4) * 0.18;
        // Face the street centreline (door toward the path), with every FRONT
        // FACE flush on the same line — width variety without ragged rows.
        const fx = -sideSign * perpx, fz = -sideSign * perpz;
        const lane = LANE + (w - 6.6) / 2;
        const ahx = ax + perpx * sideSign * lane, ahz = az + perpz * sideSign * lane;
        houses.push({
          key: p.agentId,
          name: p.name,
          pos: [ahx, 0, ahz],
          w,
          h,
          roofPeak: 0.22 + h + h * 0.85,
          wall: WALL[Math.floor(r() * WALL.length)],
          roof: DISTRICT_ROOFS[i % DISTRICT_ROOFS.length],
          door: DOOR_COLS[i % DOOR_COLS.length],
          rot: Math.atan2(fx, fz),
          chimney: r() < 0.6,
          radius: w * 0.5 + 1,
          active: p.active,
          flair: r(),
        });
      });
    });

    const extent = houses.reduce((m, h) => Math.max(m, Math.abs(h.pos[0]), Math.abs(h.pos[2])), 40) + 24;
    // The map grows with the network — the LIFE must grow with it, or a big
    // town becomes a ring of houses around empty grass. 1× at the ~30-agent
    // map, scaling with AREA, capped so a mega-network stays renderable.
    // Everything placed through findSpot/clearance checks — nothing can land
    // in a tree, on a path, or inside another vignette.
    const lifeScale = Math.min(2.5, Math.max(1, (extent / 105) ** 2));
    const nOf = (base: number) => Math.round(base * lifeScale);

    // Stones lining EVERY trail (streets densely, the longer hub roads sparser)
    // plus the odd pebble on the surface, so paths read as worn, detailed trails.
    const rs = mulberry(0x9e3779b1);
    const pathStones: { pos: Vec3; s: number; rot: number }[] = [];
    for (const p of paths) {
      const dx = p.x2 - p.x1, dz = p.z2 - p.z1;
      const len = Math.hypot(dx, dz);
      if (len < 2) continue;
      const ux = dx / len, uz = dz / len;
      const px = -uz, pz = ux;
      const step = p.main ? 4.6 : 8;
      for (let d = 2; d < len - 2; d += step) {
        for (const side of [-1, 1]) {
          const off = p.w / 2 + 0.4 + rs() * 0.3;
          pathStones.push({
            pos: [p.x1 + ux * d + px * side * off, 0, p.z1 + uz * d + pz * side * off],
            s: 0.26 + rs() * 0.28,
            rot: rs() * Math.PI * 2,
          });
        }
      }
    }

    // Flagstones embedded down the centre of every trail, weaving slightly.
    const flagstones: { x: number; z: number; s: number; rot: number; c: number }[] = [];
    for (const p of paths) {
      const dx = p.x2 - p.x1, dz = p.z2 - p.z1;
      const len = Math.hypot(dx, dz);
      if (len < 2) continue;
      const ux = dx / len, uz = dz / len;
      const px = -uz, pz = ux;
      let k = 0;
      for (let d = 1.6; d < len - 1.6; d += 2.3) {
        const lat = ((k++ % 3) - 1) * p.w * 0.16 + (rs() - 0.5) * 0.3;
        flagstones.push({ x: p.x1 + ux * d + px * lat, z: p.z1 + uz * d + pz * lat, s: 0.5 + rs() * 0.22, rot: rs() * Math.PI, c: k % 3 });
      }
    }

    const houseSolids = houses.map((h) => ({ x: h.pos[0], z: h.pos[2], r: h.radius }));
    const clearOfPaths = (x: number, z: number, pad: number) =>
      paths.every((p) => distToSeg(x, z, p.x1, p.z1, p.x2, p.z2) > p.w / 2 + pad);

    // Three BIG fishing areas — each pond owns a sandy clearing (no trees, no
    // scatter) so it reads as a destination, not scenery dropped on the grass.
    const ponds: { pos: Vec3; r: number; seed: number; dockA: number }[] = [];
    const rp = mulberry(0x90d1e);
    for (let i = 0; i < nOf(3); i++) {
      for (let tries = 0; tries < 60; tries++) {
        const a = rp() * Math.PI * 2;
        // Anywhere in the grass between plaza and the map edge — a big map
        // deserves ponds in its outer meadows too, not just the inner ring.
        const rad = PLAZA_R + 14 + rp() * Math.max(10, extent - PLAZA_R - 36);
        const x = Math.cos(a) * rad, z = Math.sin(a) * rad, pr = 6.5 + rp() * 2;
        if (Math.hypot(x, z) < PLAZA_R + pr + 9 || Math.hypot(x, z) > extent - pr - 8) continue;
        if (houseSolids.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + pr + 8)) continue;
        if (!clearOfPaths(x, z, pr + 4)) continue;
        if (ponds.some((q) => Math.hypot(x - q.pos[0], z - q.pos[2]) < q.r + pr + 22)) continue;
        const seed = 0x1000 + i * 137;
        ponds.push({ pos: [x, 0, z], r: pr, seed, dockA: mulberry(seed ^ 0xd0c)() * Math.PI * 2 });
        break;
      }
    }
    // Collision: only the water itself (you can walk the whole clearing + shore).
    const pondSolids = ponds.map((p) => ({ x: p.pos[0], z: p.pos[2], r: p.r + 0.5 }));
    // Clearing: nothing else spawns inside this radius, so the area stays open.
    const pondClear = ponds.map((p) => ({ x: p.pos[0], z: p.pos[2], r: p.r + 6.6 }));

    // Fishing spots: x/z is the shore-end trigger, sx/sz is where the cinematic
    // stands you — out on the dock planks over the water, facing the bobber.
    const fishSpots = ponds.map((p) => {
      const dx = Math.cos(p.dockA), dz = Math.sin(p.dockA);
      return {
        x: p.pos[0] + dx * (p.r + 1.3),
        z: p.pos[2] + dz * (p.r + 1.3),
        sx: p.pos[0] + dx * (p.r - 1.6),
        sz: p.pos[2] + dz * (p.r - 1.6),
        ry: Math.atan2(-dx, -dz),
        bx: p.pos[0] + dx * Math.max(p.r - 4.2, 1),
        bz: p.pos[2] + dz * Math.max(p.r - 4.2, 1),
      };
    });

    // ——— Meadow fillers: a farmstead, orchards, berry bushes, campfires and a
    // relic site, each claiming a clear patch of grass (never on paths/houses).
    const rf = mulberry(0xf177e5);
    const vignettes: { x: number; z: number; r: number }[] = [];
    // ── The river + maze footprints are fixed geography: computed FIRST so
    // every random placement (orchards, campfires, farm, trees…) avoids them.
    // The river grows WITH the map: radius cap and arc length both scale from
    // the ~30-agent baseline (extent ≈ 105, where these equal the old fixed
    // values exactly), so a bigger town gets a longer river that crosses more
    // streets — and every crossing gets its bridge automatically.
    const riverCap = 34 + Math.max(0, extent - 105) * 0.5;
    const riverR = Math.max(23, Math.min(riverCap, (RING - maxHalfLen) * 0.62));
    const riverA0 = mids.length ? mids[0] : 0;
    const riverSpan =
      N >= 3
        ? Math.min(Math.PI * 1.3, Math.max((Math.PI * 4) / N, (extent * 0.58) / riverR))
        : Math.PI * 0.9;
    const riverA1 = riverA0 + riverSpan;
    const riverEnds = [riverA0, riverA1].map((a) => ({ x: Math.cos(a) * riverR, z: Math.sin(a) * riverR }));
    const inRiver = (x: number, z: number, extra: number): boolean => {
      if (riverEnds.some((e) => Math.hypot(x - e.x, z - e.z) < 5 + extra)) return true;
      const r = Math.hypot(x, z);
      if (Math.abs(r - riverR) > 3.5 + extra) return false;
      let a = Math.atan2(z, x);
      while (a < riverA0) a += Math.PI * 2;
      return a <= riverA1;
    };
    // Maze: the street-gap midline farthest from the river's middle.
    const riverMidA = riverA0 + riverSpan / 2;
    const mazeCandidates = mids.filter((m) => {
      let a = m;
      while (a < riverA0) a += Math.PI * 2;
      return a > riverA1 + 0.2;
    });
    const angDist = (a: number, b: number) => {
      const d = Math.abs(a - b) % (Math.PI * 2);
      return d > Math.PI ? Math.PI * 2 - d : d;
    };
    const mazeA = mazeCandidates.length
      ? mazeCandidates.reduce((best, m) => (angDist(m, riverMidA) > angDist(best, riverMidA) ? m : best))
      : riverMidA + Math.PI;
    const mazeDist = Math.min(extent - 22, Math.max(riverR + 24, RING * 0.72));
    const mazeC = { x: Math.cos(mazeA) * mazeDist, z: Math.sin(mazeA) * mazeDist };
    const inMaze = (x: number, z: number, extra: number): boolean =>
      Math.hypot(x - mazeC.x, z - mazeC.z) < 13 + extra;

    const findSpot = (clearance: number, radMin: number, radMax: number): { x: number; z: number } | null => {
      for (let t = 0; t < 60; t++) {
        const a = rf() * Math.PI * 2;
        const rad = radMin + rf() * Math.max(1, radMax - radMin);
        const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
        if (Math.hypot(x, z) < PLAZA_R + clearance + 3 || Math.hypot(x, z) > extent - clearance - 3) continue;
        if (!clearOfPaths(x, z, clearance)) continue;
        if (houseSolids.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + clearance)) continue;
        if (pondClear.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + clearance - 3)) continue;
        if (vignettes.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + clearance + 4)) continue;
        if (inRiver(x, z, clearance)) continue;
        if (inMaze(x, z, clearance)) continue;
        vignettes.push({ x, z, r: clearance });
        return { x, z };
      }
      return null;
    };
    const farm = findSpot(15, PLAZA_R + 26, extent - 26);
    const farmRot = farm ? Math.atan2(-farm.x, -farm.z) : 0; // the barn faces the plaza
    const stones = findSpot(8, PLAZA_R + 18, extent - 16);
    // The Hall of Fame garden — statues of the network's top agents, facing home.
    const hof = findSpot(11, PLAZA_R + 16, extent - 22);
    const hofRot = hof ? Math.atan2(-hof.x, -hof.z) : 0;
    const hofOff = (dx: number, dz: number) =>
      hof
        ? { x: hof.x + dx * Math.cos(hofRot) + dz * Math.sin(hofRot), z: hof.z - dx * Math.sin(hofRot) + dz * Math.cos(hofRot) }
        : { x: 0, z: 0 };
    const orchards = Array.from({ length: nOf(2) }, () => findSpot(9, PLAZA_R + 14, extent - 14)).filter(Boolean) as { x: number; z: number }[];
    const orchardTrees: { x: number; z: number; s: number }[] = [];
    for (const o of orchards) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rf();
        const d = 3.2 + rf() * 3.2;
        orchardTrees.push({ x: o.x + Math.cos(a) * d, z: o.z + Math.sin(a) * d, s: 0.95 + rf() * 0.35 });
      }
    }
    const berryBushes: { x: number; z: number; s: number }[] = [];
    for (let i = 0; i < nOf(7); i++) {
      const sp = findSpot(2.5, PLAZA_R + 10, extent - 8);
      if (sp) berryBushes.push({ x: sp.x, z: sp.z, s: 0.95 + rf() * 0.4 });
    }
    const campfires: { x: number; z: number }[] = [];
    for (let i = 0; i < nOf(3); i++) {
      const sp = findSpot(5, PLAZA_R + 12, extent - 12);
      if (sp) campfires.push(sp);
    }
    // Log seats around each campfire — sittable, facing the flames.
    const fireLogs: { x: number; z: number; ry: number }[] = [];
    for (const c of campfires) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.6;
        const lx = c.x + Math.cos(a) * 2.1, lz = c.z + Math.sin(a) * 2.1;
        fireLogs.push({ x: lx, z: lz, ry: Math.atan2(c.x - lx, c.z - lz) });
      }
    }
    // Treasure dig sites — clusters of glinting mounds, dug with E.
    const digSites: { x: number; z: number }[] = [];
    for (let i = 0; i < nOf(2); i++) {
      const sp = findSpot(6, PLAZA_R + 14, extent - 10);
      if (sp) digSites.push(sp);
    }
    const digMounds: { x: number; z: number }[] = [];
    for (const d of digSites) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.9;
        digMounds.push({ x: d.x + Math.cos(a) * 2.2, z: d.z + Math.sin(a) * 2.2 });
      }
    }
    // Bounce mushroom patches — step on a cap to get launched.
    const shrooms: { x: number; z: number; s: number }[] = [];
    for (let i = 0; i < nOf(2); i++) {
      const sp = findSpot(4.5, PLAZA_R + 12, extent - 10);
      if (sp) shrooms.push({ x: sp.x - 1.3, z: sp.z + 0.4, s: 1 }, { x: sp.x + 1.5, z: sp.z - 0.7, s: 0.8 });
    }
    const bouncePads = shrooms.map((m) => ({ x: m.x, z: m.z, r: 1.05 * m.s }));

    // Everywhere you can pick or dig something up.
    const gatherSpots: GatherSpot[] = [
      ...orchardTrees.map((t, i) => ({ id: `apple-${i}`, kind: "apple" as const, x: t.x, z: t.z })),
      ...berryBushes.map((b, i) => ({ id: `berry-${i}`, kind: "berry" as const, x: b.x, z: b.z })),
      ...digMounds.map((d, i) => ({ id: `dig-${i}`, kind: "dig" as const, x: d.x, z: d.z })),
    ];
    // World-space offsets of the farm pieces (for their colliders).
    const farmOff = (dx: number, dz: number) =>
      farm
        ? { x: farm.x + dx * Math.cos(farmRot) + dz * Math.sin(farmRot), z: farm.z - dx * Math.sin(farmRot) + dz * Math.cos(farmRot) }
        : { x: 0, z: 0 };

    // Greenery on an EVEN jittered grid, skipping the hub, houses, paths + ponds
    // so it spreads uniformly and never lands on a trail or in the water.
    const rng = mulberry(0x5eed);
    const trees: { pos: Vec3; s: number; variant: "round" | "pine" | "blossom" | "autumn" }[] = [];
    const bushes: Vec3[] = [];
    const rocks: { pos: Vec3; s: number; rot: number }[] = [];
    const variants = ["round", "pine", "blossom", "autumn"] as const;
    const CELL = 15.5; // greenery grid (kept moderate for a smooth framerate)
    for (let gx = -extent; gx <= extent; gx += CELL) {
      for (let gz = -extent; gz <= extent; gz += CELL) {
        const x = gx + (rng() - 0.5) * CELL * 0.7;
        const z = gz + (rng() - 0.5) * CELL * 0.7;
        if (Math.hypot(x, z) < PLAZA_R + 2 || Math.hypot(x, z) > extent) continue;
        if (houseSolids.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + 3)) continue;
        if (pondClear.some((s) => Math.hypot(x - s.x, z - s.z) < s.r)) continue;
        if (vignettes.some((s) => Math.hypot(x - s.x, z - s.z) < s.r)) continue;
        if (!clearOfPaths(x, z, 2.5)) continue;
        // Never inside a district signpost, the river, or the garden — at any
        // town size (these checks matter more the bigger the map gets).
        if (signs.some((sg) => Math.hypot(x - sg.pos[0], z - sg.pos[2]) < 3.2)) continue;
        if (inRiver(x, z, 1.5) || inMaze(x, z, 1)) continue;
        const roll = rng();
        if (roll < 0.76) trees.push({ pos: [x, 0, z], s: 1 + rng() * 0.7, variant: variants[Math.floor(rng() * 4)] });
        else if (roll < 0.9) bushes.push([x, 0, z]);
        else rocks.push({ pos: [x, 0, z], s: 0.6 + rng() * 0.7, rot: rng() * Math.PI * 2 });
      }
    }

    // Dense grass + flower scatter (rendered instanced, so it stays cheap).
    const rg = mulberry(0x6a55e);
    const grass: { x: number; z: number; s: number; c: number }[] = [];
    const CELL_G = 5.5;
    for (let gx = -extent; gx <= extent; gx += CELL_G) {
      for (let gz = -extent; gz <= extent; gz += CELL_G) {
        const x = gx + (rg() - 0.5) * CELL_G * 0.8;
        const z = gz + (rg() - 0.5) * CELL_G * 0.8;
        if (Math.hypot(x, z) < PLAZA_R + 1 || Math.hypot(x, z) > extent) continue;
        if (houseSolids.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + 1)) continue;
        if (pondClear.some((s) => Math.hypot(x - s.x, z - s.z) < s.r - 0.5)) continue;
        if (!clearOfPaths(x, z, 0.5)) continue;
        grass.push({ x, z, s: 0.8 + rg() * 0.55, c: Math.floor(rg() * 3) });
      }
    }
    // Tufts hugging the trail edges so the grass grows INTO the paths.
    for (const p of paths) {
      const dx = p.x2 - p.x1, dz = p.z2 - p.z1;
      const len = Math.hypot(dx, dz);
      if (len < 2) continue;
      const ux = dx / len, uz = dz / len;
      const px = -uz, pz = ux;
      for (let d = 1.5; d < len - 1.5; d += 3.2) {
        for (const side of [-1, 1]) {
          const off = p.w / 2 + 0.45 + rg() * 0.4;
          grass.push({ x: p.x1 + ux * d + px * side * off, z: p.z1 + uz * d + pz * side * off, s: 0.65 + rg() * 0.4, c: Math.floor(rg() * 3) });
        }
      }
    }

    // Meadow flower patches, kept clear of everything.
    const flowerSpots: { x: number; z: number }[] = [];
    const CELL_F = 17;
    for (let gx = -extent; gx <= extent; gx += CELL_F) {
      for (let gz = -extent; gz <= extent; gz += CELL_F) {
        const x = gx + (rg() - 0.5) * CELL_F * 0.7;
        const z = gz + (rg() - 0.5) * CELL_F * 0.7;
        if (Math.hypot(x, z) < PLAZA_R + 4 || Math.hypot(x, z) > extent - 3) continue;
        if (houseSolids.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + 2)) continue;
        if (pondClear.some((s) => Math.hypot(x - s.x, z - s.z) < s.r)) continue;
        if (vignettes.some((s) => Math.hypot(x - s.x, z - s.z) < s.r)) continue;
        if (!clearOfPaths(x, z, 1.6)) continue;
        flowerSpots.push({ x, z });
      }
    }

    // Big soft grass-tone patches so the meadow isn't one flat green.
    const tones: { x: number; z: number; r: number; c: string; y: number }[] = [];
    // (tone patches removed — they read as odd circles on the grass)

    // Fallen-leaf carpets under the blossom + autumn trees.
    const leaves: { x: number; z: number; r: number; c: number }[] = [];
    for (const t of trees) {
      if (t.variant === "blossom") leaves.push({ x: t.pos[0], z: t.pos[2], r: (1.2 + rg() * 0.7) * t.s, c: 0 });
      else if (t.variant === "autumn") leaves.push({ x: t.pos[0], z: t.pos[2], r: (1.2 + rg() * 0.7) * t.s, c: 1 });
    }

    // Keep only the hens that landed on open grass.
    const chickens = chickenCand.filter(
      (c) => clearOfPaths(c.x, c.z, 0.9) && houseSolids.every((s) => Math.hypot(c.x - s.x, c.z - s.z) > s.r + 0.8),
    );

    // Rest stops along the hub roads — a bench + lamp + flowers halfway out, so
    // the long walks between districts have places to pause (and sit).
    const restStops: { x: number; z: number; rot: number; lx: number; lz: number; fx: number; fz: number }[] = [];
    paths.filter((p) => !p.main).forEach((p, i) => {
      const dx = p.x2 - p.x1, dz = p.z2 - p.z1;
      const len = Math.hypot(dx, dz);
      if (len < 14) return;
      const ux = dx / len, uz = dz / len;
      const px = -uz, pz = ux;
      const side = i % 2 === 0 ? 1 : -1;
      const off = p.w / 2 + 1.9;
      const mx = (p.x1 + p.x2) / 2 + px * side * off;
      const mz = (p.z1 + p.z2) / 2 + pz * side * off;
      if (pondClear.some((s) => Math.hypot(mx - s.x, mz - s.z) < s.r + 2)) return;
      if (houseSolids.some((s) => Math.hypot(mx - s.x, mz - s.z) < s.r + 2)) return;
      restStops.push({
        x: mx, z: mz,
        rot: Math.atan2(-px * side, -pz * side), // bench faces the path
        lx: mx + ux * 2.5, lz: mz + uz * 2.5,
        fx: mx - ux * 2.3, fz: mz - uz * 2.3,
      });
    });

    // Everywhere a visitor can sit: plaza benches, rest stops + campfire logs.
    const benchSpots: { x: number; z: number; ry: number }[] = [
      ...furniture.benches.map((b) => ({ x: b.x, z: b.z, ry: b.ry })),
      ...restStops.map((rs) => ({ x: rs.x, z: rs.z, ry: rs.rot })),
      ...fireLogs,
    ];

    // The plaza job board — in the grass ring on a street-gap midline (never a
    // path mouth), front facing the monument. NOT mids[0]: the Ring Run start
    // post lives on that midline at the same radius, and stacking them made E
    // start the minigame instead of opening the board.
    const boardAngle = mids.length > 1 ? mids[1] : mids.length ? mids[0] + Math.PI : Math.PI / 4;
    const board = {
      x: Math.cos(boardAngle) * 14.2,
      z: Math.sin(boardAngle) * 14.2,
      ry: Math.atan2(-Math.cos(boardAngle), -Math.sin(boardAngle)),
    };
    // The pipeline desk takes the NEXT free midline over (Ring Run holds
    // mids[0], the job board mids[1]).
    const deskAngle = mids.length > 2 ? mids[2] : boardAngle + Math.PI;
    const desk = {
      x: Math.cos(deskAngle) * 14.2,
      z: Math.sin(deskAngle) * 14.2,
      ry: Math.atan2(-Math.cos(deskAngle), -Math.sin(deskAngle)),
    };
    // The world map board takes the next free midline (mids[3]) — as the town
    // grows, "where is everything?" needs an answer at the plaza.
    const mapAngle = mids.length > 3 ? mids[3] : deskAngle + Math.PI / 2;
    const mapBoard = {
      x: Math.cos(mapAngle) * 14.2,
      z: Math.sin(mapAngle) * 14.2,
      ry: Math.atan2(-Math.cos(mapAngle), -Math.sin(mapAngle)),
    };
    // Landmark coordinates for the map board panel + overlay.
    const landmarks = {
      farm,
      hof,
      garden: mazeC,
      ponds: ponds.map((p) => ({ x: p.pos[0], z: p.pos[2] })),
      river: { x: Math.cos(riverMidA) * riverR, z: Math.sin(riverMidA) * riverR },
      riverArc: { r: riverR, a0: riverA0, span: riverSpan },
      streets: streetAngles,
      extent,
    };

    // Fixed geography wins: pull scattered decoration out of the water, the
    // spring pools and the maze footprint (they were placed before those had
    // physical form on the ground).
    {
      const veg = (x: number, z: number, extra: number) => !inRiver(x, z, extra) && !inMaze(x, z, extra);
      for (let i = trees.length - 1; i >= 0; i--) if (!veg(trees[i].pos[0], trees[i].pos[2], 1.6)) trees.splice(i, 1);
      for (let i = bushes.length - 1; i >= 0; i--) if (!veg(bushes[i][0], bushes[i][2], 0.8)) bushes.splice(i, 1);
      for (let i = grass.length - 1; i >= 0; i--) if (!veg(grass[i].x, grass[i].z, 0)) grass.splice(i, 1);
      for (let i = flowerSpots.length - 1; i >= 0; i--) if (!veg(flowerSpots[i].x, flowerSpots[i].z, 0.6)) flowerSpots.splice(i, 1);
      for (let i = leaves.length - 1; i >= 0; i--) if (!veg(leaves[i].x, leaves[i].z, 0)) leaves.splice(i, 1);
      for (let i = tones.length - 1; i >= 0; i--) if (!veg(tones[i].x, tones[i].z, 0)) tones.splice(i, 1);
      for (let i = shrooms.length - 1; i >= 0; i--) if (!veg(shrooms[i].x, shrooms[i].z, 1.2)) shrooms.splice(i, 1);
      for (let i = digMounds.length - 1; i >= 0; i--) if (!veg(digMounds[i].x, digMounds[i].z, 1.2)) digMounds.splice(i, 1);
      for (let i = orchardTrees.length - 1; i >= 0; i--) if (!veg(orchardTrees[i].x, orchardTrees[i].z, 1.6)) orchardTrees.splice(i, 1);
      for (let i = berryBushes.length - 1; i >= 0; i--) if (!veg(berryBushes[i].x, berryBushes[i].z, 1.2)) berryBushes.splice(i, 1);
      // gatherSpots were derived from the pre-filter arrays — prune to match.
      for (let i = gatherSpots.length - 1; i >= 0; i--) if (!veg(gatherSpots[i].x, gatherSpots[i].z, 1.2)) gatherSpots.splice(i, 1);
    }

    // River fixtures derived from the early core: bridges where streets cross,
    // walk-blocking bank solids (tight at the crossings so you can't sidestep
    // into the water), pool rims, bank stones + reeds.
    const riverBridges = streetAngles
      .map((sa) => (sa < riverA0 ? sa + Math.PI * 2 : sa))
      .filter((sa) => sa > riverA0 + 0.12 && sa < riverA1 - 0.12);
    const riverSolids: Collider[] = [];
    const rSteps = Math.max(10, Math.floor((riverSpan * riverR) / 2.4));
    for (let i = 0; i <= rSteps; i++) {
      const a = riverA0 + (i / rSteps) * riverSpan;
      if (riverBridges.some((sa) => Math.abs(a - sa) * riverR < 2.7)) continue;
      riverSolids.push({ x: Math.cos(a) * riverR, z: Math.sin(a) * riverR, r: 2.3 });
    }
    for (const e of riverEnds) {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        riverSolids.push({ x: e.x + Math.cos(a) * 3.7, z: e.z + Math.sin(a) * 3.7, r: 1.1 });
      }
    }
    const riverRng = mulberry(0x51e3);
    for (let i = 0; i < Math.floor(riverSpan * riverR * 0.16); i++) {
      const a = riverA0 + riverRng() * riverSpan;
      if (riverBridges.some((sa) => Math.abs(a - sa) * riverR < 5)) continue;
      const side = riverRng() < 0.5 ? -1 : 1;
      const rr = riverR + side * (2.9 + riverRng() * 0.8);
      rocks.push({ pos: [Math.cos(a) * rr, 0, Math.sin(a) * rr], s: 0.3 + riverRng() * 0.45, rot: riverRng() * Math.PI * 2 });
    }
    const riverReeds: { pos: Vec3; s: number }[] = [];
    for (let i = 0; i < 16; i++) {
      const a = riverA0 + riverRng() * riverSpan;
      if (riverBridges.some((sa) => Math.abs(a - sa) * riverR < 5)) continue;
      const side = riverRng() < 0.5 ? -1 : 1;
      const rr = riverR + side * (2.5 + riverRng() * 0.7);
      riverReeds.push({ pos: [Math.cos(a) * rr, 0, Math.sin(a) * rr], s: 0.8 + riverRng() * 0.5 });
    }
    // A few trees leaning over the banks make the river read as a place.
    for (let i = 0; i < 9; i++) {
      const a = riverA0 + riverRng() * riverSpan;
      if (riverBridges.some((sa) => Math.abs(a - sa) * riverR < 6)) continue;
      const side = riverRng() < 0.5 ? -1 : 1;
      const rr = riverR + side * (6.2 + riverRng() * 1.6);
      const tx = Math.cos(a) * rr;
      const tz = Math.sin(a) * rr;
      if (!clearOfPaths(tx, tz, 2.4) || inMaze(tx, tz, 2)) continue;
      if (houseSolids.some((h) => Math.hypot(tx - h.x, tz - h.z) < h.r + 3)) continue;
      // Never inside another tree's canopy — overlapping green+pink canopies
      // read as one broken two-tone tree.
      if (trees.some((t) => Math.hypot(tx - t.pos[0], tz - t.pos[2]) < 4.2)) continue;
      trees.push({ pos: [tx, 0, tz], s: 0.9 + riverRng() * 0.4, variant: riverRng() < 0.6 ? "round" : "blossom" });
    }
    const river = { r: riverR, a0: riverA0, span: riverSpan, bridges: riverBridges, reeds: riverReeds };

    // The hedge garden (replaced the maze): a hedge ring with one entrance
    // facing the plaza, flowers and benches inside, the daily chest at its
    // heart. Simple to walk, impossible to mis-generate.
    const gardenR = 8;
    const mazeWalls: { x: number; z: number }[] = [];
    const GBLOCKS = 22;
    for (let i = 0; i < GBLOCKS; i++) {
      const th = (i / GBLOCKS) * Math.PI * 2;
      if (angDist(th, Math.atan2(-mazeC.z, -mazeC.x)) < 0.55) continue; // the gateway
      mazeWalls.push({ x: mazeC.x + Math.cos(th) * gardenR, z: mazeC.z + Math.sin(th) * gardenR });
    }
    // Chest tucked into a corner between hedges — a small hunt, not a handout.
    const chestA = Math.atan2(-mazeC.z, -mazeC.x) + Math.PI * 0.72;
    const mazeChest = { x: mazeC.x + Math.cos(chestA) * (gardenR - 2.6), z: mazeC.z + Math.sin(chestA) * (gardenR - 2.6) };
    const maze = { walls: mazeWalls, chest: mazeChest, center: { x: mazeC.x, z: mazeC.z }, rot: 0 };
    // Four chairs ringing the fountain, all facing the water.
    for (let i = 0; i < 4; i++) {
      const ca = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const bx = mazeC.x + Math.cos(ca) * 3.4;
      const bz = mazeC.z + Math.sin(ca) * 3.4;
      benchSpots.push({ x: bx, z: bz, ry: Math.atan2(mazeC.x - bx, mazeC.z - bz) });
    }
    // Flower beds on the cardinal sides — between the chairs, never under them.
    for (let i = 0; i < 4; i++) {
      const fa = (i / 4) * Math.PI * 2;
      flowerSpots.push({ x: mazeC.x + Math.cos(fa) * 5.4, z: mazeC.z + Math.sin(fa) * 5.4 });
    }

    // Wheat fields + hay near the farmstead — kept off the paths and furniture.
    const wheatRng = mulberry(0x3ea7);
    const wheat: { x: number; z: number; s: number; lean: number }[] = [];
    const wheatPatches: { x: number; z: number; w: number; d: number; rot: number }[] = [];
    if (farm) {
      for (const [dx, dz] of [[-14, 6], [13, -4]] as const) {
        const cx = farm.x + dx * Math.cos(farmRot) + dz * Math.sin(farmRot);
        const cz = farm.z - dx * Math.sin(farmRot) + dz * Math.cos(farmRot);
        if (Math.hypot(cx, cz) > extent - 10) continue;
        if (!clearOfPaths(cx, cz, 6) || inRiver(cx, cz, 6) || inMaze(cx, cz, 6)) continue;
        wheatPatches.push({ x: cx, z: cz, w: 9, d: 7, rot: farmRot });
        for (let i = 0; i < 150; i++) {
          const ox = (wheatRng() - 0.5) * 8.4;
          const oz = (wheatRng() - 0.5) * 6.4;
          const sx = cx + ox * Math.cos(farmRot) + oz * Math.sin(farmRot);
          const sz = cz - ox * Math.sin(farmRot) + oz * Math.cos(farmRot);
          if (!clearOfPaths(sx, sz, 1.4)) continue;
          if (restStops.some((rs) => Math.hypot(sx - rs.x, sz - rs.z) < 3 || Math.hypot(sx - rs.lx, sz - rs.lz) < 2.2)) continue;
          wheat.push({ x: sx, z: sz, s: 0.8 + wheatRng() * 0.5, lean: (wheatRng() - 0.5) * 0.24 });
        }
      }
    }

    // Deer graze the far meadows, away from the maze and the river span.
    const deerRng = mulberry(0xdee7);
    const deer: { x: number; z: number }[] = [];
    for (let i = 0; i < 3 && extent > 60; i++) {
      const a = mazeA + Math.PI * (0.55 + deerRng() * 0.9);
      const rad = extent - 18 - deerRng() * 14;
      const dx2 = Math.cos(a) * rad;
      const dz2 = Math.sin(a) * rad;
      if (inRiver(dx2, dz2, 4) || inMaze(dx2, dz2, 4)) continue;
      deer.push({ x: dx2, z: dz2 });
    }

    // Laundry lines between neighbouring houses on the same street side —
    // parallel facades 9–16 apart, a few per world, deterministic.
    const laundry: { a: [number, number]; b: [number, number] }[] = [];
    for (let i = 0; i < houses.length && laundry.length < 8; i++) {
      for (let j = i + 1; j < houses.length; j++) {
        const hi = houses[i];
        const hj = houses[j];
        if (Math.abs(hi.rot - hj.rot) > 0.01) continue;
        const d = Math.hypot(hi.pos[0] - hj.pos[0], hi.pos[2] - hj.pos[2]);
        if (d < 9 || d > 16 || (i + j) % 3 !== 0) continue;
        laundry.push({ a: [hi.pos[0], hi.pos[2]], b: [hj.pos[0], hj.pos[2]] });
        break;
      }
    }

    // Obstacles the grazing animals must route around: buildings, trees, the
    // fishing clearings + the meadow vignettes.
    const obstacles = [
      ...houseSolids,
      ...trees.map((t) => ({ x: t.pos[0], z: t.pos[2], r: 1.1 })),
      ...pondClear,
      ...vignettes,
      // The river + its pools: grazing circles must not cross the water.
      ...Array.from({ length: 40 }, (_, i) => {
        const a = riverA0 + (i / 39) * riverSpan;
        return { x: Math.cos(a) * riverR, z: Math.sin(a) * riverR, r: 4 };
      }),
      ...riverEnds.map((e) => ({ x: e.x, z: e.z, r: 5 })),
    ];

    // EVERYTHING the player collides with — no more walking through the
    // monument, benches, lamps, signs, stalls, trees or the pond furniture.
    const decorSolids: Collider[] = [
      { x: 0, z: 0, r: 3.2 }, // plaza monument
      { x: board.x, z: board.z, r: 0.85 }, // job board
      { x: mapBoard.x, z: mapBoard.z, r: 0.85 }, // world map board
      { x: desk.x, z: desk.z, r: 0.6 }, // pipeline desk
      ...riverSolids,
      ...mazeWalls.map((w) => ({ x: w.x, z: w.z, r: 1.3 })),
      { x: mazeC.x, z: mazeC.z, r: 1.9 }, // garden fountain
      ...furniture.lamps.map((l) => ({ x: l.x, z: l.z, r: 0.4 })),
      ...furniture.benches.map((b) => ({ x: b.x, z: b.z, r: 0.9 })),
      ...furniture.stalls.map((s) => ({ x: s.x, z: s.z, r: 1.5 })),
      ...lamps.map((p) => ({ x: p[0], z: p[2], r: 0.4 })),
      ...signs.map((s) => ({ x: s.pos[0], z: s.pos[2], r: 0.45 })),
      ...restStops.flatMap((rs) => [
        { x: rs.x, z: rs.z, r: 0.9 },
        { x: rs.lx, z: rs.lz, r: 0.4 },
      ]),
      ...ponds.flatMap((p) => {
        const at = (a: number, rad: number) => ({ x: p.pos[0] + Math.cos(a) * rad, z: p.pos[2] + Math.sin(a) * rad });
        return [
          { ...at(p.dockA + 0.75, p.r + 2.9), r: 0.4 }, // lantern
          { ...at(p.dockA - 0.6, p.r + 2.7), r: 0.45 }, // fishing sign
          { ...at(p.dockA + 2.1, p.r + 2.6), r: 0.85 }, // log seats
          { ...at(p.dockA - 2.1, p.r + 2.6), r: 0.85 },
        ];
      }),
      ...trees.map((t) => ({ x: t.pos[0], z: t.pos[2], r: Math.min(0.75 * t.s, 1.05) })),
      ...rocks.filter((rk) => rk.s > 0.75).map((rk) => ({ x: rk.pos[0], z: rk.pos[2], r: 0.55 * rk.s })),
      // Meadow-filler colliders: farm pieces, relic stones, trees/bushes/fires.
      ...(farm
        ? [
            { ...farmOff(0, 0), r: 4.4 }, // barn
            { ...farmOff(8.5, -2), r: 2.1 }, // windmill
            { ...farmOff(6, 5), r: 3.4 }, // veggie garden
            { ...farmOff(-6.2, 4.1), r: 1.6 }, // hay bales
            { ...farmOff(-5.5, -3), r: 1.4 }, // cart
            // Paddock: fence posts + the residents + trough + spare hay
            ...paddockPosts().map(([px, pz]) => ({ ...farmOff(px, pz), r: 0.3 })),
            { ...farmOff(PADDOCK.cx - 1.6, PADDOCK.cz + 0.8), r: 0.95 }, // sheep
            { ...farmOff(PADDOCK.cx + 1.4, PADDOCK.cz - 0.9), r: 1.15 }, // cow
            { ...farmOff(PADDOCK.cx + 2.8, PADDOCK.cz + 1.9), r: 0.8 }, // trough
            { ...farmOff(PADDOCK.cx - 3.2, PADDOCK.cz - 1.6), r: 0.95 }, // hay
          ]
        : []),
      ...(stones
        ? [
            ...Array.from({ length: 6 }, (_, i) => {
              const a = (i / 6) * Math.PI * 2;
              return { x: stones.x + Math.cos(a) * 4.2, z: stones.z + Math.sin(a) * 4.2, r: 0.85 };
            }),
            { x: stones.x, z: stones.z, r: 1.5 },
          ]
        : []),
      ...orchardTrees.map((t) => ({ x: t.x, z: t.z, r: 1.05 })),
      ...berryBushes.map((b) => ({ x: b.x, z: b.z, r: 0.9 })),
      ...campfires.map((c) => ({ x: c.x, z: c.z, r: 1.05 })),
      ...fireLogs.map((l) => ({ x: l.x, z: l.z, r: 0.7 })),
      // Orchard sign + crate at each grove's heart; dig mounds are low but solid.
      ...orchards.flatMap((o) => [
        { x: o.x, z: o.z, r: 0.75 },
        { x: o.x + 1.4, z: o.z + 0.4, r: 0.45 },
      ]),
      ...digMounds.map((d) => ({ x: d.x, z: d.z, r: 0.55 })),
      // Hall of Fame: pedestals, signpost and the hedge crescent (only when the
      // garden actually renders — no invisible walls on a fame-less network).
      // Pedestal colliders track the REAL statue count (1-3): the garden renders
      // only as many statues as there are ranked agents, so reserving all three
      // footprints would leave invisible walls where the 2nd/3rd statue isn't.
      ...(hof && plots.some((p) => (p.reputation ?? 0) > 0)
        ? [
            ...([[0, -1.0], [-3.5, 0.8], [3.5, 0.8]] as const)
              .slice(0, Math.min(3, plots.filter((p) => (p.reputation ?? 0) > 0).length))
              .map(([dx, dz]) => ({ ...hofOff(dx, dz), r: 1.45 })),
            { ...hofOff(6.4, 2.4), r: 0.45 },
            { ...hofOff(-3.6, 5.8), r: 0.9 },
            { ...hofOff(3.6, 5.8), r: 0.9 },
            { ...hofOff(-5.6, 1.8), r: 0.3 },
            { ...hofOff(5.6, 1.8), r: 0.3 },
            { ...hofOff(-2.6, -5.6), r: 0.3 },
            { ...hofOff(2.6, -5.6), r: 0.3 },
            { ...hofOff(-1.7, 6.0), r: 0.25 },
            { ...hofOff(1.7, 6.0), r: 0.25 },
            { ...hofOff(-5.4, -3.6), r: 0.85 },
            { ...hofOff(5.4, -3.6), r: 0.85 },
            ...Array.from({ length: 7 }, (_, i) => {
              const th = (i - 3) * 0.34;
              return { ...hofOff(Math.sin(th) * 7.0, -Math.cos(th) * 7.0), r: 0.9 };
            }),
          ]
        : []),
    ];
    const allSolids: Collider[] = [...houseSolids, ...pondSolids, ...decorSolids];

    return { houses, houseSolids, pondSolids, ponds, obstacles, allSolids, paths, pathStones, flagstones, extent, lamps, signs, trees, bushes, rocks, grass, flowerSpots, tones, leaves, chickens, fishSpots, restStops, benchSpots, furniture, streetAngles, farm, farmRot, stones, orchards, orchardTrees, berryBushes, campfires, fireLogs, gatherSpots, digMounds, shrooms, bouncePads, board, desk, laundry, river, maze, wheat, wheatPatches, deer, hof, hofRot, mapBoard, landmarks };
  }, [plots]);

  // Who earned a statue — the network's top reputations, live from the plots.
  const hofTop = useMemo(
    () =>
      [...plots]
        .filter((p) => (p.reputation ?? 0) > 0)
        .sort((a, b) => (b.reputation ?? 0) - (a.reputation ?? 0))
        .slice(0, 3)
        .map((p, i) => ({ name: p.name, rank: i + 1 })),
    [plots],
  );

  // Every lamp post in the world, gathered for ONE instanced pool (5 draw
  // calls total): district streets, rest stops, pond shores and the plaza
  // ring. Always visible — no pop-in.
  const lampItems = useMemo(
    () => [
      ...layout.lamps.map((p) => ({ x: p[0], y: p[1], z: p[2] })),
      ...layout.restStops.map((rs) => ({ x: rs.lx, y: 0, z: rs.lz })),
      ...layout.ponds.map((p) => ({
        x: p.pos[0] + Math.cos(p.dockA + 0.75) * (p.r + 2.9),
        y: p.pos[1],
        z: p.pos[2] + Math.sin(p.dockA + 0.75) * (p.r + 2.9),
      })),
      ...layout.furniture.lamps.map((l) => ({ x: l.x, y: 0, z: l.z })),
    ],
    [layout],
  );
  // Every repeated bench (rest stops, plaza, hedge garden) for the instanced
  // bench pool. One-off benches (house flair, Hall of Fame) stay components.
  const benchItems = useMemo(() => {
    const items = [
      ...layout.restStops.map((rs) => ({ x: rs.x, y: 0, z: rs.z, ry: rs.rot })),
      ...layout.furniture.benches.map((b) => ({ x: b.x, y: 0.02, z: b.z, ry: b.ry })),
    ];
    // The four garden benches ringing the maze fountain.
    for (let i = 0; i < 4; i++) {
      const ca = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const bx = layout.maze.center.x + Math.cos(ca) * 3.4;
      const bz = layout.maze.center.z + Math.sin(ca) * 3.4;
      items.push({ x: bx, y: 0.02, z: bz, ry: Math.atan2(layout.maze.center.x - bx, layout.maze.center.z - bz) });
    }
    return items;
  }, [layout]);

  useEffect(() => {
    // Player collides with buildings, water AND all the world furniture.
    onSolids?.(layout.allSolids);
  }, [layout, onSolids]);
  useEffect(() => {
    onBuildings?.(layout.houses.map((h) => ({ key: h.key, x: h.pos[0], z: h.pos[2], rot: h.rot, w: h.w, peak: h.roofPeak })));
  }, [layout, onBuildings]);
  useEffect(() => {
    onFishSpots?.(layout.fishSpots);
  }, [layout, onFishSpots]);
  useEffect(() => {
    onBenches?.(layout.benchSpots);
  }, [layout, onBenches]);
  useEffect(() => {
    onGatherSpots?.(layout.gatherSpots);
  }, [layout, onGatherSpots]);
  useEffect(() => {
    onBoard?.(layout.board);
  }, [layout, onBoard]);
  useEffect(() => {
    onDesk?.(layout.desk);
    onMapBoard?.(layout.mapBoard);
    onLandmarks?.(layout.landmarks);
  }, [layout, onDesk, onMapBoard, onLandmarks]);
  useEffect(() => {
    // Daily gift chests sit beside ACTIVE agents' front doors — a reason to
    // walk the streets. World-space position = the chest's door-side offset
    // rotated into the house's frame.
    onChests?.(
      layout.houses
        .filter((h) => h.active)
        .map((h) => {
          const lx = h.w * 0.36;
          const lz = h.w / 2 + 0.55;
          const cos = Math.cos(h.rot);
          const sin = Math.sin(h.rot);
          return { id: h.key, x: h.pos[0] + lx * cos + lz * sin, z: h.pos[2] - lx * sin + lz * cos };
        })
        .concat([{ id: "maze-daily", x: layout.maze.chest.x, z: layout.maze.chest.z }]),
    );
  }, [layout, onChests]);
  useEffect(() => {
    onBouncePads?.(layout.bouncePads);
  }, [layout, onBouncePads]);
  useEffect(() => {
    // The walk boundary: just inside the boundary forest's first row.
    onExtent?.(layout.extent + 1);
  }, [layout, onExtent]);

  const ground = layout.extent + 250; // reaches past the (now further) mountain ring

  return (
    <group>
      {/* Big grassy ground — fog fades it into the sky at the horizon */}
      <mesh position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[ground, 64]} />
        <meshStandardMaterial color="#7ec77f" roughness={1} />
      </mesh>

      {/* Soft tone patches breaking up the flat green. Explicit draw order —
          ground (0) → patches (1, no depth write) → paths/water (2) — so the
          patches can never float above the trails, even from the sky view where
          depth precision collapses. */}


      {/* Worn edges along the trails — darker strips where feet leave the path */}
      {layout.paths.map((pa, i) => {
        const dx = pa.x2 - pa.x1;
        const dz = pa.z2 - pa.z1;
        const len = Math.hypot(dx, dz);
        if (len < 4) return null;
        const ry = Math.atan2(dx, dz);
        const px = -dz / len;
        const pz = dx / len;
        const mx = (pa.x1 + pa.x2) / 2;
        const mz = (pa.z1 + pa.z2) / 2;
        const off = pa.w / 2 + 0.18;
        return (
          <group key={`pw${i}`}>
            {[-1, 1].map((side) => (
              <mesh
                key={side}
                position={[mx + px * side * off, 0.028, mz + pz * side * off]}
                rotation={[-Math.PI / 2, 0, ry]}
                renderOrder={1.9}
              >
                <planeGeometry args={[0.5, len * 0.96]} />
                <meshStandardMaterial color="#8f7a55" transparent opacity={0.35} roughness={1} depthWrite={false} />
              </mesh>
            ))}
          </group>
        );
      })}

      {/* Central plaza (spawn hub) */}
      <group name="plaza"><CentralPlaza detail={!lowPower} furniture={layout.furniture} streetAngles={layout.streetAngles} title={showTitle} /></group>

      {/* Paths — a sandy base with a darker worn centre for depth */}
      {layout.paths.map((p, i) => {
        const dx = p.x2 - p.x1, dz = p.z2 - p.z1;
        const len = Math.hypot(dx, dz);
        if (len < 1) return null;
        const rot: Vec3 = [0, -Math.atan2(dz, dx), 0];
        const mid: Vec3 = [(p.x1 + p.x2) / 2, 0.01, (p.z1 + p.z2) / 2];
        return (
          <group key={i}>
            <mesh position={mid} rotation={rot} receiveShadow renderOrder={2}>
              <boxGeometry args={[len + p.w, 0.04, p.w]} />
              <meshStandardMaterial color="#cdb489" roughness={1} />
            </mesh>
            <mesh position={[mid[0], 0.025, mid[2]]} rotation={rot} receiveShadow renderOrder={2.1}>
              <boxGeometry args={[len, 0.04, p.w * 0.6]} />
              <meshStandardMaterial color="#b89b6c" roughness={1} />
            </mesh>
          </group>
        );
      })}

      {/* Stones lining the streets + field rocks (ONE instanced draw call) and
          the flagstones worn into the trails */}
      <InstancedRocks rocks={[...layout.pathStones, ...layout.rocks]} />
      <Flagstones stones={layout.flagstones} />

      {/* District signposts (beside each street entrance) */}
      {layout.signs.map((s) => (
        <Signpost key={s.text} text={s.text} position={s.pos} />
      ))}

      {/* Buildings + their name signs (above the roof peak so they're readable) */}
      {/* Every house sign, one merged mesh — visible from anywhere */}
      <HouseSignAtlas houses={layout.houses.map((h) => ({ key: h.key, pos: h.pos, rot: h.rot, roofPeak: h.roofPeak, name: h.name }))} />
      {/* Two instanced draw calls carry the whole distant town */}
      <group name="farhouses"><FarHouses houses={layout.houses} playerRef={playerPosRef} /></group>
      {layout.houses.map((h) => (
        <group key={h.key} name="house" position={h.pos}>
          <WithinRange x={h.pos[0]} z={h.pos[2]} range={24} playerRef={playerPosRef}>
            <AgentHouse w={h.w} h={h.h} wall={h.wall} roof={h.roof} rotation={h.rot} chimney={h.chimney} active={h.active} detail={!lowPower} flair={h.flair} doorOpen={knockId === h.key} doorCol={h.door} />
            {trophyIds?.has(h.key) && trophyRarities && trophyRarities.length > 0 && (
              <TrophyShelf rarities={trophyRarities} w={h.w} rotation={h.rot} />
            )}
            {h.active && <GiftChest w={h.w} rotation={h.rot} opened={openedChestIds?.has(h.key) ?? false} />}
            {catAt(h.key) && (
              <DoorCat
                w={h.w}
                rotation={h.rot}
                coat={catAt(h.key)!}
                mood={(["sleep", "chill", "play"] as const)[hashStr(h.key + "mood") % 3]}
              />
            )}
          </WithinRange>
          <WithinRange x={h.pos[0]} z={h.pos[2]} range={38} playerRef={playerPosRef}>
            {bidderIds?.has(h.key) && <BidLantern w={h.w} rotation={h.rot} />}
          </WithinRange>
        </group>
      ))}

      {/* The plaza job board — real open tasks, readable with E */}
      <BidBoardStand x={layout.board.x} z={layout.board.z} ry={layout.board.ry} />
      <MapBoardStand
        x={layout.mapBoard.x}
        z={layout.mapBoard.z}
        ry={layout.mapBoard.ry}
        extent={layout.extent}
        streetAngles={layout.streetAngles}
        houses={layout.houses.map((h) => ({ x: h.pos[0], z: h.pos[2] }))}
        landmarks={layout.landmarks}
      />

      {/* The river between plaza and districts */}
      <group name="river"><River river={layout.river} /></group>

      {/* The hedge garden — fountain at the heart, treasure in a corner */}
      <MazeHedges walls={layout.maze.walls} />
      <WithinRange x={layout.maze.center.x} z={layout.maze.center.z} range={60} playerRef={playerPosRef}>
        <GardenFountain x={layout.maze.center.x} z={layout.maze.center.z} />
      </WithinRange>
      {/* (The four garden benches around the fountain render via the
          world-wide InstancedBenches pool.) */}
      <group position={[layout.maze.chest.x - 0.79, 0, layout.maze.chest.z - 1.65]}>
        <GiftChest w={2.2} rotation={0} opened={openedChestIds?.has("maze-daily") ?? false} />
      </group>

      {/* Farmland spread: wheat, its keeper, and hay */}
      <group name="wheat"><WheatField stalks={layout.wheat} /></group>
      {layout.wheatPatches.map((wp, i) => (
        <WithinRange key={`wp${i}`} x={wp.x} z={wp.z} range={55} playerRef={playerPosRef}>
          <Scarecrow x={wp.x + 4.2} z={wp.z + 3.4} rot={wp.rot + 0.4} />
          <HayBale position={[wp.x - 4.6, 0, wp.z - 3.2]} />
        </WithinRange>
      ))}

      {/* Sky + fauna */}
      <group name="balloon"><Balloon extent={layout.extent} /></group>
      {layout.deer.map((d, i) => (
        <WithinRange key={`de${i}`} x={d.x} z={d.z} range={75} playerRef={playerPosRef}>
          <Deer home={d} playerPosRef={playerPosRef} />
        </WithinRange>
      ))}

      {/* The pipeline desk — open a work order, walk the streets, run the chain */}
      <PipelineDesk x={layout.desk.x} z={layout.desk.z} ry={layout.desk.ry} />

      {/* Micro-life: laundry lines between neighbours + fireflies at the ponds */}
      {layout.laundry.map((l, i) => (
        <WithinRange key={`ll${i}`} x={(l.a[0] + l.b[0]) / 2} z={(l.a[1] + l.b[1]) / 2} range={48} playerRef={playerPosRef}>
          <LaundryLine a={l.a} b={l.b} />
        </WithinRange>
      ))}
      <Fireflies ponds={layout.ponds} />
      <NightDriver />
      <LampGlowDriver />

      {/* Always-visible instanced pools — every lamp, bench and orchard plant
          in the world in a handful of draw calls, no distance gating. */}
      <group name="lamps"><InstancedLamps items={lampItems} /></group>
      <group name="benches"><InstancedBenches items={benchItems} /></group>
      <group name="orchard">
        <InstancedAppleTrees items={layout.orchardTrees} />
        <InstancedBerryBushes items={layout.berryBushes} />
      </group>

      {/* Fishing areas */}
      {layout.ponds.map((p, i) => (
        <group key={`pond${i}`} name="pond">
          <Pond position={p.pos} r={p.r} seed={p.seed} dockA={p.dockA} playerRef={playerPosRef} />
        </group>
      ))}

      {/* Rest stops along the hub roads — sit, look, breathe. The bench and
          lamp render via the always-visible instanced pools; only the small
          flower patch still culls at distance. */}
      {layout.restStops.map((rs, i) => (
        <WithinRange key={`rest${i}`} x={rs.x} z={rs.z} range={55} playerRef={playerPosRef}>
          <Flowers position={[rs.fx, 0, rs.fz]} scale={1.1} />
        </WithinRange>
      ))}

      {/* The golden hen — catch it for a Golden Egg */}
      <GoldenHen playerPosRef={playerPosRef} extent={layout.extent} obstacles={layout.obstacles} onCaught={onHenCaught} />

      {/* The world's edge: pine wall → forested hills → mountains */}
      <group name="boundary"><BoundaryScenery extent={layout.extent} /></group>

      {/* Hall of Fame — the top agents by reputation, in bronze, facing home */}
      {layout.hof && hofTop.length > 0 && (
        <group name="halloffame" position={[layout.hof.x, 0, layout.hof.z]} rotation={[0, layout.hofRot, 0]}>
          <HallOfFame top={hofTop} />
        </group>
      )}

      {/* The week's top agents staff the plaza stalls — names + real prices */}
      {stallStaff && stallStaff.length > 0 && (
        <group name="plaza">
          {layout.furniture.stalls.map((s, i) => {
            const a = stallStaff[i];
            if (!a) return null;
            return (
              <group key={`staff${i}`} position={[s.x, 0.02, s.z]} rotation={[0, s.ry, 0]}>
                <StallVendor name={a.name} />
                <StallSign name={a.name} price={a.price} />
              </group>
            );
          })}
        </group>
      )}

      {/* Meadow vignettes — a farmstead, a relic site, orchards, berries, campfires */}
      {layout.farm && (
        <group name="farm" position={[layout.farm.x, 0, layout.farm.z]} rotation={[0, layout.farmRot, 0]}>
          <Barn position={[0, 0, 0]} />
          <Windmill position={[8.5, 0, -2]} rotation={0.4} />
          <WithinRange x={layout.farm.x} z={layout.farm.z} range={60} playerRef={playerPosRef}>
          <VeggieGarden position={[6, 0, 5]} rotation={0.15} />
          <HayBale position={[-6, 0, 4]} rotation={0.3} />
          <HayBale position={[-7.3, 0, 3.2]} rotation={-0.6} />
          <HayBale position={[-5.2, 0, 5.1]} rotation={1.1} scale={0.9} />
          <Cart position={[-5.5, 0, -3]} rotation={-0.5} />

          {/* Fenced paddock with residents — dirt yard, post-and-rail fence,
              a sheep + cow grazing, a water trough and a spare hay bale. */}
          <mesh position={[PADDOCK.cx, 0.012, PADDOCK.cz]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1.6}>
            <circleGeometry args={[4.8, 22]} />
            <meshStandardMaterial color="#9a7a4e" roughness={1} depthWrite={false} />
          </mesh>
          {paddockPosts().map(([px, pz], i) => (
            <mesh key={`pp${i}`} position={[px, 0.5, pz]} castShadow>
              <cylinderGeometry args={[0.08, 0.09, 1, 6]} />
              <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
            </mesh>
          ))}
          {[0.38, 0.76].map((y, k) => (
            <group key={`rl${k}`}>
              <mesh position={[PADDOCK.cx, y, PADDOCK.cz - PADDOCK.d / 2]}>
                <boxGeometry args={[PADDOCK.w, 0.07, 0.07]} />
                <meshStandardMaterial color="#7a4a24" roughness={0.9} />
              </mesh>
              <mesh position={[PADDOCK.cx, y, PADDOCK.cz + PADDOCK.d / 2]}>
                <boxGeometry args={[PADDOCK.w, 0.07, 0.07]} />
                <meshStandardMaterial color="#7a4a24" roughness={0.9} />
              </mesh>
              <mesh position={[PADDOCK.cx - PADDOCK.w / 2, y, PADDOCK.cz]}>
                <boxGeometry args={[0.07, 0.07, PADDOCK.d]} />
                <meshStandardMaterial color="#7a4a24" roughness={0.9} />
              </mesh>
              <mesh position={[PADDOCK.cx + PADDOCK.w / 2, y, PADDOCK.cz]}>
                <boxGeometry args={[0.07, 0.07, PADDOCK.d]} />
                <meshStandardMaterial color="#7a4a24" roughness={0.9} />
              </mesh>
            </group>
          ))}
          <Sheep position={[PADDOCK.cx - 1.6, 0, PADDOCK.cz + 0.8]} rotation={2.2} />
          <Cow position={[PADDOCK.cx + 1.4, 0, PADDOCK.cz - 0.9]} rotation={-0.6} />
          {/* Water trough */}
          <group position={[PADDOCK.cx + 2.8, 0, PADDOCK.cz + 1.9]} rotation={[0, 0.3, 0]}>
            <mesh position={[0, 0.22, 0]} castShadow>
              <boxGeometry args={[1.3, 0.44, 0.6]} />
              <meshStandardMaterial color="#7a5230" roughness={0.95} />
            </mesh>
            <mesh position={[0, 0.4, 0]}>
              <boxGeometry args={[1.14, 0.06, 0.44]} />
              <meshStandardMaterial color="#4a90c2" roughness={0.2} metalness={0.3} />
            </mesh>
          </group>
          <HayBale position={[PADDOCK.cx - 3.2, 0, PADDOCK.cz - 1.6]} rotation={0.7} scale={0.85} />
          </WithinRange>
        </group>
      )}
      {layout.stones && (
        <WithinRange x={layout.stones.x} z={layout.stones.z} range={60} playerRef={playerPosRef}>
          <StandingStones position={[layout.stones.x, 0, layout.stones.z]} />
        </WithinRange>
      )}
      {/* (Orchard apple trees + berry bushes render via the always-visible
          instanced pools up by the lamps.) */}
      {/* Orchard heart: a signpost + an apple crate, so the groves are findable */}
      {layout.orchards.map((o, i) => (
        <WithinRange key={`orc${i}`} x={o.x} z={o.z} range={60} playerRef={playerPosRef}>
        <group>
          <group position={[o.x, 0, o.z]}>
            <mesh position={[0, 0.95, 0]} castShadow>
              <cylinderGeometry args={[0.09, 0.11, 1.9, 7]} />
              <meshStandardMaterial color="#7a4a24" roughness={0.9} />
            </mesh>
            <Signboard text="🍎 Orchard" position={[0, 2.2, 0]} scale={3.6} />
          </group>
          <group position={[o.x + 1.4, 0, o.z + 0.4]} rotation={[0, 0.4, 0]}>
            <mesh position={[0, 0.25, 0]} castShadow>
              <boxGeometry args={[0.75, 0.5, 0.55]} />
              <meshStandardMaterial color="#a97c50" roughness={0.9} />
            </mesh>
            {[[0.12, 0.1], [-0.14, -0.08], [0.02, -0.16]].map(([ax, az], k) => (
              <mesh key={k} position={[ax, 0.54, az]}>
                <sphereGeometry args={[0.13, 8, 8]} />
                <meshStandardMaterial color={k % 2 ? "#d9382e" : "#e8b02e"} roughness={0.55} />
              </mesh>
            ))}
          </group>
        </group>
        </WithinRange>
      ))}
      {/* Treasure dig mounds (one shovel per site) + bounce mushrooms */}
      {layout.digMounds.map((d, i) => (
        <WithinRange key={`dm${i}`} x={d.x} z={d.z} range={45} playerRef={playerPosRef}>
          <DigMound position={[d.x, 0, d.z]} shovel={i % 3 === 0} />
        </WithinRange>
      ))}
      {layout.shrooms.map((m, i) => (
        <WithinRange key={`sh${i}`} x={m.x} z={m.z} range={55} playerRef={playerPosRef}>
          <BounceShroom position={[m.x, 0, m.z]} s={m.s} fxRef={bounceFxRef} />
        </WithinRange>
      ))}
      {layout.campfires.map((c, i) => (
        <WithinRange key={`cf${i}`} x={c.x} z={c.z} range={65} playerRef={playerPosRef}>
          <Campfire position={[c.x, 0, c.z]} />
        </WithinRange>
      ))}
      {layout.fireLogs.map((l, i) => (
        <WithinRange key={`flog${i}`} x={l.x} z={l.z} range={65} playerRef={playerPosRef}>
        <mesh position={[l.x, 0.26, l.z]} rotation={[0, l.ry, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.24, 0.24, 1.6, 8]} />
          <meshStandardMaterial color="#7a5230" roughness={0.95} />
        </mesh>
        </WithinRange>
      ))}

      {/* Ground cover — instanced grass, flowers and leaf litter */}
      <group name="grass"><GrassField spots={layout.grass} /></group>
      <FlowerField spots={layout.flowerSpots} />
      <LeafPatches patches={layout.leaves} />

      {/* Greenery (all instanced) + grazing livestock */}
      <group name="trees"><InstancedTrees trees={layout.trees} /></group>
      {!lowPower && <InstancedBushes positions={layout.bushes} />}
      <Livestock area={layout.extent} obstacles={layout.obstacles} reportRef={animalsRef} />

      {/* Hens pecking near the district signposts */}
      {layout.chickens.map((c, i) => (
        <WithinRange key={`ch${i}`} x={c.x} z={c.z} range={50} playerRef={playerPosRef}>
          <Chicken position={[c.x, 0, c.z]} rotation={c.rot} />
        </WithinRange>
      ))}

      {/* Pet the animals — E next to any sheep, cow or hen */}
      <Petting playerPosRef={playerPosRef} animalsRef={animalsRef} chickens={layout.chickens} onNear={onNearPet} />

      {/* Sky + ambient life */}
      <DriftingClouds extent={layout.extent} />
      <SkyBirds extent={layout.extent} />
      {!lowPower && <Pollen extent={layout.extent} />}
      {!lowPower && <Butterflies spots={layout.flowerSpots} />}
    </group>
  );
});
