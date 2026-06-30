"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { nightFactor } from "./dayCycle";

// Shared low-poly nature props for the Axon World scenes — a sun, puffy clouds,
// and simple trees. Pure R3F components (rendered only inside a <Canvas>), kept
// bright and stylized to match the KausaWorld look.

type Vec3 = [number, number, number];

// Multiply a #rrggbb hex colour by `f` (0..1) to get a darker shade of it.
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * f);
  const g = Math.round(((n >> 8) & 0xff) * f);
  const b = Math.round((n & 0xff) * f);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// Blend a #rrggbb hex colour toward white by `f` (0..1) for a highlight tone.
export function lighten(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) + (255 - ((n >> 16) & 0xff)) * f);
  const g = Math.round(((n >> 8) & 0xff) + (255 - ((n >> 8) & 0xff)) * f);
  const b = Math.round((n & 0xff) + (255 - (n & 0xff)) * f);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export function Sun({ position }: { position: Vec3 }) {
  return (
    <group position={position}>
      {/* Core with a hot centre */}
      <mesh>
        <sphereGeometry args={[6, 24, 24]} />
        <meshBasicMaterial color="#fff3b0" toneMapped={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[4.2, 20, 20]} />
        <meshBasicMaterial color="#fffbe0" toneMapped={false} />
      </mesh>
      {/* Layered halos */}
      <mesh>
        <sphereGeometry args={[9.5, 24, 24]} />
        <meshBasicMaterial color="#fff0a0" transparent opacity={0.22} toneMapped={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[13, 20, 20]} />
        <meshBasicMaterial color="#ffe98a" transparent opacity={0.08} toneMapped={false} />
      </mesh>
    </group>
  );
}

// Shared cloud resources — one unit sphere + two materials reused by every
// cloud instance, so extra puffs never mean extra materials/geometries.
const CLOUD_GEO = new THREE.SphereGeometry(1, 12, 10);
const CLOUD_TOP_MAT = new THREE.MeshStandardMaterial({
  color: "#ffffff",
  roughness: 1,
  transparent: true,
  opacity: 0.95,
  depthWrite: true,
});
const CLOUD_BASE_MAT = new THREE.MeshStandardMaterial({
  color: "#e6ecf2",
  roughness: 1,
  transparent: true,
  opacity: 0.94,
  depthWrite: true,
});

// Cheap deterministic hash → 0..1, so per-cloud variation is stable per frame.
function cloudHash(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

export function Cloud({ position, scale = 1 }: { position: Vec3; scale?: number }) {
  const [px, py, pz] = position;
  const cloud = useMemo(() => {
    const rnd = (i: number) => cloudHash(px + i * 13.71, py - i * 5.19, pz + i * 7.37);
    const n = 6 + Math.floor(rnd(0) * 2.999); // 6-8 main puffs
    const span = 2.9 + rnd(1) * 1.1; // half-length of the cloud
    const puffs: { p: Vec3; s: Vec3 }[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * 2 - 1; // -1..1 along the cloud
      // Bigger puffs in the middle, smaller toward the ends.
      const r = 1.05 + (1 - t * t) * 1.15 + (rnd(i + 2) - 0.5) * 0.3;
      const sy = 0.66 + rnd(i + 20) * 0.08; // slight y-squash per puff
      puffs.push({
        // Centre each puff so its bottom sits near y≈-1.45 → flat underside.
        p: [
          t * span + (rnd(i + 40) - 0.5) * 0.5,
          r * sy - 1.45 + rnd(i + 60) * 0.12,
          (rnd(i + 80) - 0.5) * 1.1,
        ],
        s: [r, r * sy, r * 0.92],
      });
    }
    return { puffs, span };
  }, [px, py, pz]);
  return (
    <group position={position} scale={scale}>
      {cloud.puffs.map((q, i) => (
        <mesh key={i} position={q.p} scale={q.s} geometry={CLOUD_GEO} material={CLOUD_TOP_MAT} />
      ))}
      {/* Wide flattened, slightly shaded base puff for soft depth underneath. */}
      <mesh
        position={[0, -1.15, 0]}
        scale={[cloud.span + 1, 0.8, 1.85]}
        geometry={CLOUD_GEO}
        material={CLOUD_BASE_MAT}
      />
    </group>
  );
}

// A stylized low-poly building: a coloured body with glassy window bands and a
// roof (flat cap or a cute pyramid), so it reads as a building instead of a bar.
export function Building({
  position,
  w,
  d,
  h,
  color,
  roof,
}: {
  position: Vec3;
  w: number;
  d: number;
  h: number;
  color: string;
  roof: "flat" | "pyramid";
}) {
  const floors = Math.max(1, Math.floor(h / 3.2));
  const cap = Math.max(w, d);
  return (
    <group position={position}>
      {/* Body */}
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} roughness={0.75} metalness={0.04} />
      </mesh>
      {/* Glassy window bands — one per floor */}
      {Array.from({ length: floors }).map((_, i) => (
        <mesh key={i} position={[0, i * 3.2 + 1.9, 0]}>
          <boxGeometry args={[w + 0.05, 0.95, d + 0.05]} />
          <meshStandardMaterial
            color="#cfe7ff"
            emissive="#8fbce8"
            emissiveIntensity={0.3}
            roughness={0.25}
            metalness={0.15}
          />
        </mesh>
      ))}
      {/* Roof */}
      {roof === "pyramid" ? (
        <mesh position={[0, h + cap * 0.42, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
          <coneGeometry args={[cap * 0.78, cap * 0.85, 4]} />
          <meshStandardMaterial color="#dd6f5f" roughness={0.85} />
        </mesh>
      ) : (
        <mesh position={[0, h + 0.35, 0]} castShadow>
          <boxGeometry args={[w * 1.1, 0.7, d * 1.1]} />
          <meshStandardMaterial color="#eef2f8" roughness={0.85} />
        </mesh>
      )}
    </group>
  );
}

// Layered blob foliage — several overlapping spheres in two tones for a fuller,
// more detailed canopy than a single sphere.
function Canopy({ a, b }: { a: string; b: string }) {
  // A deliberate rounded crown (dome) instead of a random lump: a core, a wide
  // mid ring for a full silhouette, a tucked shadow ring underneath, and sunlit
  // highlight puffs on top for volume.
  const c = shade(a, 0.76);
  const hi = lighten(b, 0.34);
  // Fewer, larger blobs for the same rounded silhouette at a fraction of the
  // draw calls. Only the core casts a shadow (the rest are cheap to skip).
  const blobs: [number, number, number, number, string][] = [];
  blobs.push([0, 3.55, 0, 1.55, a]); // core
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    blobs.push([Math.cos(ang) * 1.2, 3.35, Math.sin(ang) * 1.2, 1.0, i % 2 ? b : a]);
  }
  blobs.push([0, 2.9, 0, 1.15, c]); // shadow underside
  blobs.push([0, 4.45, 0, 0.95, hi]); // top highlight
  blobs.push([0.42, 4.2, 0.26, 0.6, hi]);
  return (
    <>
      {blobs.map(([x, y, z, r, col], i) => (
        <mesh key={i} position={[x, y, z]} castShadow={i === 0}>
          <sphereGeometry args={[r, 12, 10]} />
          <meshStandardMaterial color={col} roughness={0.9} />
        </mesh>
      ))}
    </>
  );
}

export function Tree({
  position,
  scale = 1,
  variant = "round",
  rotation = 0,
}: {
  position: Vec3;
  scale?: number;
  variant?: "round" | "pine" | "blossom" | "autumn";
  rotation?: number;
}) {
  return (
    <group position={position} scale={scale} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1, 0]} castShadow>
        <cylinderGeometry args={[0.26, 0.38, 2, 8]} />
        <meshStandardMaterial color="#8a5a2b" roughness={1} />
      </mesh>
      {/* Root flare at the base */}
      <mesh position={[0, 0.14, 0]} castShadow>
        <coneGeometry args={[0.55, 0.4, 8]} />
        <meshStandardMaterial color="#7a4f26" roughness={1} />
      </mesh>
      {/* Branch stubs reaching into the canopy */}
      {variant !== "pine" && (
        <>
          <mesh position={[0.32, 1.9, 0.1]} rotation={[0, 0, -0.7]}>
            <cylinderGeometry args={[0.07, 0.11, 0.9, 6]} />
            <meshStandardMaterial color="#7a4f26" roughness={1} />
          </mesh>
          <mesh position={[-0.28, 2.1, -0.14]} rotation={[0.3, 0, 0.65]}>
            <cylinderGeometry args={[0.06, 0.1, 0.8, 6]} />
            <meshStandardMaterial color="#7a4f26" roughness={1} />
          </mesh>
        </>
      )}
      {variant === "pine" ? (
        <>
          <mesh position={[0, 2.4, 0]} castShadow>
            <coneGeometry args={[1.5, 2, 8]} />
            <meshStandardMaterial color="#3f8f5a" roughness={0.9} />
          </mesh>
          <mesh position={[0, 3.4, 0]} castShadow>
            <coneGeometry args={[1.15, 1.8, 8]} />
            <meshStandardMaterial color="#469862" roughness={0.9} />
          </mesh>
          <mesh position={[0, 4.3, 0]} castShadow>
            <coneGeometry args={[0.8, 1.5, 8]} />
            <meshStandardMaterial color="#3f8f5a" roughness={0.9} />
          </mesh>
        </>
      ) : variant === "blossom" ? (
        <Canopy a="#f4a6c0" b="#f8bcd0" />
      ) : variant === "autumn" ? (
        <Canopy a="#e08a3c" b="#d4652f" />
      ) : (
        <Canopy a="#5fbf6a" b="#6fcf79" />
      )}
    </group>
  );
}

// A blocky (Minecraft-style) villager (an agent) — cube head + face, box body,
// arms and legs. When `walking` it plays a limb-swing + bob; when idle it sways.
// Colours vary per villager for a crowd feel. Forward is +Z.
export function Villager({
  shirt,
  hair = "#3a2a1a",
  skin = "#e8c0a0",
  hat,
  pants = "#3a3a4a",
  walking = false,
}: {
  shirt: string;
  hair?: string;
  skin?: string;
  hat?: string;
  pants?: string;
  walking?: boolean;
}) {
  const torso = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const phase = useRef(0);
  const clock = useRef(0);
  useEffect(() => { phase.current = Math.random() * 6; }, []);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    clock.current += dt;
    if (walking) {
      phase.current += dt * 7;
      const s = Math.sin(phase.current) * 0.55;
      if (legL.current) legL.current.rotation.x = s;
      if (legR.current) legR.current.rotation.x = -s;
      if (armL.current) armL.current.rotation.x = -s * 0.8;
      if (armR.current) armR.current.rotation.x = s * 0.8;
      if (torso.current) torso.current.position.y = 0.6 + Math.abs(Math.sin(phase.current)) * 0.04;
    } else {
      const sway = Math.sin(clock.current * 1.5 + phase.current) * 0.06;
      if (armL.current) armL.current.rotation.x = sway;
      if (armR.current) armR.current.rotation.x = -sway;
    }
  });
  const leg = (ref: React.RefObject<THREE.Group | null>, x: number) => (
    <group ref={ref} position={[x, 0.6, 0]}>
      <mesh position={[0, -0.3, 0]}>
        <boxGeometry args={[0.26, 0.6, 0.3]} />
        <meshStandardMaterial color={pants} roughness={0.9} />
      </mesh>
      <mesh position={[0, -0.62, 0.02]}>
        <boxGeometry args={[0.29, 0.12, 0.36]} />
        <meshStandardMaterial color="#3a3a44" roughness={0.8} />
      </mesh>
    </group>
  );
  const arm = (ref: React.RefObject<THREE.Group | null>, x: number) => (
    <group ref={ref} position={[x, 0.62, 0]}>
      <mesh position={[0, -0.28, 0]}>
        <boxGeometry args={[0.19, 0.58, 0.28]} />
        <meshStandardMaterial color={shirt} roughness={0.85} />
      </mesh>
      <mesh position={[0, -0.6, 0]}>
        <boxGeometry args={[0.2, 0.12, 0.3]} />
        <meshStandardMaterial color={skin} roughness={0.9} />
      </mesh>
    </group>
  );
  return (
    <group scale={0.72}>
      {leg(legL, -0.15)}
      {leg(legR, 0.15)}
      {/* Belt */}
      <mesh position={[0, 0.63, 0]}>
        <boxGeometry args={[0.66, 0.09, 0.36]} />
        <meshStandardMaterial color="#4a3626" roughness={0.9} />
      </mesh>
      <group ref={torso} position={[0, 0.6, 0]}>
        <mesh position={[0, 0.32, 0]} castShadow>
          <boxGeometry args={[0.64, 0.66, 0.34]} />
          <meshStandardMaterial color={shirt} roughness={0.85} />
        </mesh>
        {/* Collar + placket trim */}
        <mesh position={[0, 0.61, 0]}>
          <boxGeometry args={[0.48, 0.07, 0.37]} />
          <meshStandardMaterial color={shade(shirt, 0.72)} roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.32, 0.176]}>
          <boxGeometry args={[0.07, 0.6, 0.02]} />
          <meshStandardMaterial color={shade(shirt, 0.8)} roughness={0.85} />
        </mesh>
        {arm(armL, -0.42)}
        {arm(armR, 0.42)}
        {/* Head (cube) */}
        <group position={[0, 0.66, 0]}>
          <mesh position={[0, 0.3, 0]} castShadow>
            <boxGeometry args={[0.58, 0.58, 0.58]} />
            <meshStandardMaterial color={skin} roughness={0.95} />
          </mesh>
          {/* Eyes — whites + pupils, with brows */}
          {[-0.12, 0.12].map((x, i) => (
            <group key={i} position={[x, 0.33, 0.3]}>
              <mesh>
                <boxGeometry args={[0.1, 0.12, 0.02]} />
                <meshStandardMaterial color="#ffffff" roughness={0.35} />
              </mesh>
              <mesh position={[x > 0 ? 0.015 : -0.015, -0.01, 0.012]}>
                <boxGeometry args={[0.05, 0.07, 0.02]} />
                <meshStandardMaterial color="#2a2320" roughness={0.4} />
              </mesh>
              <mesh position={[0, 0.09, 0.005]}>
                <boxGeometry args={[0.11, 0.03, 0.02]} />
                <meshStandardMaterial color={hair} roughness={1} />
              </mesh>
            </group>
          ))}
          {/* Mouth */}
          <mesh position={[0, 0.13, 0.3]}>
            <boxGeometry args={[0.13, 0.03, 0.02]} />
            <meshStandardMaterial color="#9c5a4a" roughness={0.8} />
          </mesh>
          {hat ? (
            <group position={[0, 0.66, 0]}>
              <mesh castShadow>
                <boxGeometry args={[0.62, 0.2, 0.62]} />
                <meshStandardMaterial color={hat} roughness={0.8} />
              </mesh>
              <mesh position={[0, -0.1, 0.16]}>
                <boxGeometry args={[0.66, 0.05, 0.22]} />
                <meshStandardMaterial color={hat} roughness={0.8} />
              </mesh>
            </group>
          ) : (
            <>
              <mesh position={[0, 0.62, -0.02]} castShadow>
                <boxGeometry args={[0.62, 0.24, 0.64]} />
                <meshStandardMaterial color={hair} roughness={1} />
              </mesh>
              <mesh position={[0, 0.44, 0.31]}>
                <boxGeometry args={[0.62, 0.16, 0.06]} />
                <meshStandardMaterial color={hair} roughness={1} />
              </mesh>
            </>
          )}
        </group>
      </group>
    </group>
  );
}

// A path lamp with a warm glowing head.
// One material for every lamp bulb in the world — a single per-frame update
// dims them by day and lets them burn warm at night. Exported so OpenWorld's
// instanced lamp pool can share the exact same night-glow material.
export const LAMP_BULB_MAT = new THREE.MeshStandardMaterial({ color: "#fff4cf", emissive: new THREE.Color("#ffcf6b"), emissiveIntensity: 0.35, toneMapped: false });
export function LampGlowDriver() {
  useFrame((state) => {
    const n = nightFactor(state.clock.elapsedTime);
    LAMP_BULB_MAT.emissiveIntensity = 0.3 + n * 2.6;
  });
  return null;
}

export function LampPost({ position }: { position: Vec3 }) {
  return (
    <group position={position}>
      {/* Base + fluted post */}
      <mesh position={[0, 0.14, 0]} castShadow>
        <cylinderGeometry args={[0.28, 0.34, 0.28, 10]} />
        <meshStandardMaterial color="#3a3833" roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.7, 0]} castShadow>
        <cylinderGeometry args={[0.09, 0.13, 3.1, 8]} />
        <meshStandardMaterial color="#46443f" roughness={0.85} metalness={0.2} />
      </mesh>
      {/* Ornate lantern housing: cap + cage + warm bulb */}
      <mesh position={[0, 3.5, 0]} castShadow>
        <coneGeometry args={[0.34, 0.34, 6]} />
        <meshStandardMaterial color="#37352f" roughness={0.8} metalness={0.3} />
      </mesh>
      <mesh position={[0, 3.02, 0]}>
        <boxGeometry args={[0.34, 0.5, 0.34]} />
        <meshStandardMaterial color="#2f2d28" roughness={0.7} metalness={0.3} />
      </mesh>
      <mesh position={[0, 3.05, 0]} material={LAMP_BULB_MAT}>
        <sphereGeometry args={[0.2, 12, 12]} />
      </mesh>
    </group>
  );
}

// A tiny butterfly — two tilted coloured wings (flapping handled by the manager).
export function Butterfly({ color }: { color: string }) {
  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0.35]}>
        <planeGeometry args={[0.24, 0.18]} />
        <meshStandardMaterial color={color} side={THREE.DoubleSide} roughness={0.7} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, -0.35]}>
        <planeGeometry args={[0.24, 0.18]} />
        <meshStandardMaterial color={color} side={THREE.DoubleSide} roughness={0.7} />
      </mesh>
    </group>
  );
}

// A little hen — plump body, a bobbing head with beak + comb, tail feathers and
// stick legs. Pecks at the ground on its own timer. Forward is +X.
export function Chicken({ position, rotation = 0, scale = 1, gold = false }: { position: Vec3; rotation?: number; scale?: number; gold?: boolean }) {
  const head = useRef<THREE.Group>(null);
  const clock = useRef(0);
  const phase = useRef(0);
  useEffect(() => { phase.current = Math.random() * 6; }, []);
  useFrame((_, rawDt) => {
    clock.current += Math.min(rawDt, 0.05);
    if (!head.current) return;
    // Peck in quick bursts, then look around for a while.
    const c = (clock.current * 0.55 + phase.current) % 3;
    const peck = c < 0.55 ? Math.abs(Math.sin(c * Math.PI * 5.5)) : 0;
    head.current.rotation.z = -peck * 0.95;
    head.current.position.y = 0.42 - peck * 0.08;
    head.current.rotation.y = c > 1.6 && c < 2.2 ? Math.sin(clock.current * 3 + phase.current) * 0.5 : 0;
  });
  const feathers = gold ? "#f2ce6b" : "#f5efe4";
  const glow = gold ? "#a87b1e" : "#000000";
  return (
    <group position={position} rotation={[0, rotation, 0]} scale={scale}>
      {/* Body */}
      <mesh position={[0, 0.3, 0]} scale={[1.15, 0.95, 0.9]} castShadow>
        <sphereGeometry args={[0.22, 12, 12]} />
        <meshStandardMaterial color={feathers} roughness={gold ? 0.5 : 1} metalness={gold ? 0.35 : 0} emissive={glow} emissiveIntensity={gold ? 0.3 : 0} />
      </mesh>
      {/* Tail feathers */}
      <mesh position={[-0.24, 0.42, 0]} rotation={[0, 0, 0.7]}>
        <coneGeometry args={[0.09, 0.24, 5]} />
        <meshStandardMaterial color={gold ? "#e0b84f" : "#e2d4bc"} roughness={1} />
      </mesh>
      {/* Head on a short neck (pecks) */}
      <group ref={head} position={[0.2, 0.42, 0]}>
        <mesh position={[0.06, 0.12, 0]} castShadow>
          <sphereGeometry args={[0.11, 10, 10]} />
          <meshStandardMaterial color={feathers} roughness={gold ? 0.5 : 1} metalness={gold ? 0.35 : 0} emissive={glow} emissiveIntensity={gold ? 0.3 : 0} />
        </mesh>
        <mesh position={[0.17, 0.11, 0]} rotation={[0, 0, -Math.PI / 2]}>
          <coneGeometry args={[0.035, 0.11, 5]} />
          <meshStandardMaterial color="#e8a03a" roughness={0.8} />
        </mesh>
        {/* Comb + wattle */}
        <mesh position={[0.06, 0.24, 0]}>
          <boxGeometry args={[0.07, 0.08, 0.03]} />
          <meshStandardMaterial color="#d9534a" roughness={0.8} />
        </mesh>
        <mesh position={[0.14, 0.04, 0]}>
          <sphereGeometry args={[0.025, 6, 6]} />
          <meshStandardMaterial color="#d9534a" roughness={0.8} />
        </mesh>
        {/* Eyes */}
        {[0.06, -0.06].map((z, i) => (
          <mesh key={i} position={[0.12, 0.15, z]}>
            <sphereGeometry args={[0.02, 6, 6]} />
            <meshStandardMaterial color="#1c1a18" roughness={0.4} />
          </mesh>
        ))}
      </group>
      {/* Stick legs */}
      {[0.06, -0.06].map((z, i) => (
        <mesh key={i} position={[0, 0.09, z]}>
          <cylinderGeometry args={[0.016, 0.016, 0.18, 4]} />
          <meshStandardMaterial color="#e8a03a" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

// A tiny bird with flapping wings — the parent drives the flight path; the wings
// flap on their own. Forward is +X.
export function Bird({ color = "#4a4a55" }: { color?: string }) {
  const wl = useRef<THREE.Group>(null);
  const wr = useRef<THREE.Group>(null);
  const clock = useRef(0);
  useFrame((_, rawDt) => {
    clock.current += Math.min(rawDt, 0.05);
    const f = Math.sin(clock.current * 9) * 0.65;
    if (wl.current) wl.current.rotation.x = -f;
    if (wr.current) wr.current.rotation.x = f;
  });
  return (
    <group>
      {/* Body + head + beak */}
      <mesh scale={[1.4, 0.8, 0.8]}>
        <sphereGeometry args={[0.14, 8, 8]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      <mesh position={[0.17, 0.04, 0]}>
        <sphereGeometry args={[0.08, 8, 8]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      <mesh position={[0.26, 0.03, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.025, 0.09, 4]} />
        <meshStandardMaterial color="#e8a03a" roughness={0.8} />
      </mesh>
      {/* Tail */}
      <mesh position={[-0.18, 0.01, 0]} rotation={[0, 0, 0.25]}>
        <boxGeometry args={[0.14, 0.02, 0.08]} />
        <meshStandardMaterial color={shade(color, 0.8)} roughness={0.9} />
      </mesh>
      {/* Wings — pivot at the body so they beat downward */}
      <group ref={wl} position={[0, 0.05, 0.06]}>
        <mesh position={[0, 0, 0.16]}>
          <boxGeometry args={[0.24, 0.02, 0.32]} />
          <meshStandardMaterial color={shade(color, 0.8)} roughness={0.9} />
        </mesh>
      </group>
      <group ref={wr} position={[0, 0.05, -0.06]}>
        <mesh position={[0, 0, -0.16]}>
          <boxGeometry args={[0.24, 0.02, 0.32]} />
          <meshStandardMaterial color={shade(color, 0.8)} roughness={0.9} />
        </mesh>
      </group>
    </group>
  );
}

// A cozy cottage: short walls, a big overhanging pyramid roof, a door and two
// windows. The village counterpart to Building (which is a taller city tower).
export function House({
  position,
  w,
  d,
  h,
  wall,
  roof,
  rotation = 0,
  chimney = false,
  wing = false,
  porch = false,
  dormer = false,
}: {
  position: Vec3;
  w: number;
  d: number;
  h: number;
  wall: string;
  roof: string;
  rotation?: number;
  chimney?: boolean;
  wing?: boolean;
  porch?: boolean;
  dormer?: boolean;
}) {
  const roofH = Math.max(w, d) * 0.7;
  const wingW = w * 0.7;
  const wingD = d * 0.7;
  const wingH = h * 0.85;
  const wingRoofH = Math.max(wingW, wingD) * 0.7;
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Stone foundation the walls sit on */}
      <mesh position={[0, 0.14, 0]} receiveShadow castShadow>
        <boxGeometry args={[w + 0.22, 0.3, d + 0.22]} />
        <meshStandardMaterial color="#9c968c" roughness={1} />
      </mesh>
      {/* Walls (softly rounded edges) */}
      <RoundedBox args={[w, h, d]} radius={0.15} smoothness={3} position={[0, h / 2 + 0.14, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={wall} roughness={0.9} />
      </RoundedBox>
      {/* Overhanging 4-sided roof */}
      <mesh position={[0, h + 0.14 + roofH / 2, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[Math.max(w, d) * 0.82, roofH, 4]} />
        <meshStandardMaterial color={roof} roughness={0.95} />
      </mesh>
      {/* Ridge finial at the apex */}
      <mesh position={[0, h + 0.14 + roofH + 0.12, 0]}>
        <sphereGeometry args={[0.14, 8, 8]} />
        <meshStandardMaterial color={shade(roof, 0.7)} roughness={0.8} />
      </mesh>

      {/* L-shaped wing */}
      {wing && (
        <>
          <RoundedBox args={[wingW, wingH, wingD]} radius={0.13} smoothness={3} position={[w * 0.62, wingH / 2, -d * 0.32]} castShadow receiveShadow>
            <meshStandardMaterial color={wall} roughness={0.9} />
          </RoundedBox>
          <mesh position={[w * 0.62, wingH + wingRoofH / 2, -d * 0.32]} rotation={[0, Math.PI / 4, 0]} castShadow>
            <coneGeometry args={[Math.max(wingW, wingD) * 0.82, wingRoofH, 4]} />
            <meshStandardMaterial color={roof} roughness={0.95} />
          </mesh>
        </>
      )}

      {/* Dormer window on the roof */}
      {dormer && (
        <>
          <mesh position={[0, h + roofH * 0.28, d * 0.24]} castShadow>
            <boxGeometry args={[w * 0.32, roofH * 0.34, 0.55]} />
            <meshStandardMaterial color={wall} roughness={0.9} />
          </mesh>
          <mesh position={[0, h + roofH * 0.28, d * 0.24 + 0.28]}>
            <boxGeometry args={[w * 0.18, roofH * 0.2, 0.06]} />
            <meshStandardMaterial color="#cfe7ff" emissive="#8fbce8" emissiveIntensity={0.25} roughness={0.3} />
          </mesh>
        </>
      )}

      {/* Door — a pale frame, dark panel and a stone step */}
      <mesh position={[0, 0.99, d / 2 + 0.02]}>
        <boxGeometry args={[Math.min(1.1, w * 0.28) + 0.18, 1.86, 0.08]} />
        <meshStandardMaterial color={shade(wall, 0.72)} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.99, d / 2 + 0.06]}>
        <boxGeometry args={[Math.min(1.1, w * 0.28), 1.7, 0.1]} />
        <meshStandardMaterial color="#5b3a22" roughness={0.9} />
      </mesh>
      <mesh position={[Math.min(1.1, w * 0.28) * 0.28, 0.99, d / 2 + 0.12]}>
        <sphereGeometry args={[0.055, 8, 8]} />
        <meshStandardMaterial color="#e8c766" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.18, d / 2 + 0.18]} receiveShadow>
        <boxGeometry args={[Math.min(1.1, w * 0.28) + 0.4, 0.16, 0.5]} />
        <meshStandardMaterial color="#9c968c" roughness={1} />
      </mesh>

      {/* Porch: an overhang on two posts over the door */}
      {porch && (
        <>
          <mesh position={[0, h * 0.72, d / 2 + 0.7]} castShadow>
            <boxGeometry args={[w * 0.72, 0.14, 1.4]} />
            <meshStandardMaterial color={roof} roughness={0.9} />
          </mesh>
          {[-w * 0.3, w * 0.3].map((x, i) => (
            <mesh key={i} position={[x, (h * 0.72) / 2, d / 2 + 1.3]}>
              <cylinderGeometry args={[0.08, 0.08, h * 0.72, 6]} />
              <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
            </mesh>
          ))}
        </>
      )}

      {/* Windows — pale frame, glowing glass and a cross muntin */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * w * 0.29, h * 0.62 + 0.14, d / 2 + 0.02]}>
          <mesh>
            <boxGeometry args={[w * 0.16 + 0.12, w * 0.16 + 0.12, 0.08]} />
            <meshStandardMaterial color={shade(wall, 0.72)} roughness={0.9} />
          </mesh>
          <mesh position={[0, 0, 0.03]}>
            <boxGeometry args={[w * 0.16, w * 0.16, 0.1]} />
            <meshStandardMaterial color="#cfe7ff" emissive="#8fbce8" emissiveIntensity={0.25} roughness={0.3} />
          </mesh>
          <mesh position={[0, 0, 0.09]}>
            <boxGeometry args={[0.03, w * 0.16, 0.02]} />
            <meshStandardMaterial color={shade(wall, 0.72)} roughness={0.9} />
          </mesh>
          <mesh position={[0, 0, 0.09]}>
            <boxGeometry args={[w * 0.16, 0.03, 0.02]} />
            <meshStandardMaterial color={shade(wall, 0.72)} roughness={0.9} />
          </mesh>
          {/* Window flower box */}
          <mesh position={[0, -w * 0.11, 0.12]}>
            <boxGeometry args={[w * 0.19, 0.1, 0.12]} />
            <meshStandardMaterial color="#6b4a2a" roughness={0.9} />
          </mesh>
          {[-0.06, 0, 0.06].map((dx, k) => (
            <mesh key={k} position={[dx * w, -w * 0.08, 0.14]}>
              <sphereGeometry args={[0.05, 6, 6]} />
              <meshStandardMaterial color={["#f472b6", "#fbbf24", "#f87171"][k]} roughness={0.7} />
            </mesh>
          ))}
        </group>
      ))}

      {/* Chimney + smoke */}
      {chimney && (
        <>
          <mesh position={[w * 0.28, h + roofH * 0.35, d * 0.2]} castShadow>
            <boxGeometry args={[0.5, 1.3, 0.5]} />
            <meshStandardMaterial color="#8a5a4a" roughness={0.9} />
          </mesh>
          <Smoke position={[w * 0.28, h + roofH * 0.35 + 0.9, d * 0.2]} />
        </>
      )}
    </group>
  );
}

// A cute sheep — a smooth woolly body dusted with fluff, a friendly dark face
// with a cream muzzle + eyes + droopy ears, on four legs that walk with a
// diagonal gait when `walking`. Facing/heading is +X (the head).
export function Sheep({ position, scale = 1, rotation = 0, walking = false, coat = "#efe9dc" }: { position: Vec3; scale?: number; rotation?: number; walking?: boolean; coat?: string }) {
  const body = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const lFL = useRef<THREE.Group>(null), lFR = useRef<THREE.Group>(null), lBL = useRef<THREE.Group>(null), lBR = useRef<THREE.Group>(null);
  const phase = useRef(0);
  const clock = useRef(0);
  useEffect(() => { phase.current = Math.random() * 6; }, []);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    clock.current += dt;
    // Head life: a light bob plus slow dips toward the grass, as if nibbling.
    if (head.current) head.current.position.y = Math.sin(clock.current * 1.7 + phase.current) * 0.02 - Math.max(0, Math.sin(clock.current * 0.31 + phase.current)) * 0.09;
    if (!walking) return;
    phase.current += dt * 7;
    const s = Math.sin(phase.current) * 0.5;
    if (lFL.current) lFL.current.rotation.z = s;
    if (lBR.current) lBR.current.rotation.z = s;
    if (lFR.current) lFR.current.rotation.z = -s;
    if (lBL.current) lBL.current.rotation.z = -s;
    if (body.current) body.current.position.y = Math.abs(Math.sin(phase.current)) * 0.035;
  });
  // Fluff bumps dusted over the smooth body for a woolly texture.
  const fluff: [number, number, number, number][] = [
    [0.18, 0.86, 0.16, 0.22], [-0.18, 0.86, -0.16, 0.22], [0.02, 0.94, 0, 0.24],
    [0.34, 0.72, -0.2, 0.2], [-0.34, 0.72, 0.2, 0.2], [-0.36, 0.78, -0.1, 0.19], [0.36, 0.78, 0.12, 0.19],
  ];
  const legDefs: [React.RefObject<THREE.Group | null>, number, number][] = [
    [lFL, 0.24, 0.18], [lFR, 0.24, -0.18], [lBL, -0.28, 0.18], [lBR, -0.28, -0.18],
  ];
  return (
    <group position={position} scale={scale} rotation={[0, rotation, 0]}>
      <group ref={body}>
        {/* Smooth woolly body (an ellipsoid) */}
        <mesh position={[0, 0.72, 0]} scale={[1.2, 0.92, 0.9]} castShadow>
          <sphereGeometry args={[0.52, 16, 16]} />
          <meshStandardMaterial color={coat} roughness={1} />
        </mesh>
        {fluff.map(([x, y, z, r], i) => (
          <mesh key={i} position={[x, y, z]} castShadow>
            <sphereGeometry args={[r, 8, 8]} />
            <meshStandardMaterial color={lighten(coat, 0.12)} roughness={1} />
          </mesh>
        ))}
        {/* Head (bobs + dips to graze) */}
        <group ref={head}>
        <mesh position={[0.58, 0.74, 0]} scale={[1, 1.1, 0.92]} castShadow>
          <sphereGeometry args={[0.2, 14, 14]} />
          <meshStandardMaterial color="#3a3630" roughness={1} />
        </mesh>
        {/* Cream muzzle */}
        <mesh position={[0.73, 0.68, 0]}>
          <sphereGeometry args={[0.12, 12, 12]} />
          <meshStandardMaterial color="#efe7d8" roughness={0.95} />
        </mesh>
        {/* Woolly topknot */}
        <mesh position={[0.5, 0.92, 0]}>
          <sphereGeometry args={[0.16, 10, 10]} />
          <meshStandardMaterial color="#fdfbf6" roughness={1} />
        </mesh>
        {/* Eyes (white + pupil) */}
        {[0.11, -0.11].map((z, i) => (
          <group key={i} position={[0.7, 0.78, z]}>
            <mesh><sphereGeometry args={[0.05, 10, 10]} /><meshStandardMaterial color="#ffffff" roughness={0.3} /></mesh>
            <mesh position={[0.035, 0, 0]}><sphereGeometry args={[0.028, 8, 8]} /><meshStandardMaterial color="#0f0d0c" roughness={0.3} /></mesh>
          </group>
        ))}
        {/* Droopy ears */}
        {[0.22, -0.22].map((z, i) => (
          <mesh key={i} position={[0.5, 0.72, z]} rotation={[0, 0, -0.5]} scale={[1.5, 0.7, 1]}>
            <sphereGeometry args={[0.08, 8, 8]} />
            <meshStandardMaterial color="#2f2b26" roughness={1} />
          </mesh>
        ))}
        </group>
      </group>
      {legDefs.map(([ref, x, z], i) => (
        <group key={i} ref={ref} position={[x, 0.4, z]}>
          <mesh position={[0, -0.2, 0]}>
            <cylinderGeometry args={[0.05, 0.045, 0.4, 6]} />
            <meshStandardMaterial color="#33312e" roughness={1} />
          </mesh>
          <mesh position={[0, -0.4, 0.02]}>
            <sphereGeometry args={[0.05, 6, 6]} />
            <meshStandardMaterial color="#1c1a18" roughness={0.8} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// A cute cow — rounded body with patches, a face (eyes + snout with nostrils),
// horns, ears and a swishy tail, on four legs that walk with a diagonal gait
// when `walking`. Facing/heading is +X (the head).
export function Cow({ position, scale = 1, rotation = 0, walking = false, patch = "#5b4632" }: { position: Vec3; scale?: number; rotation?: number; walking?: boolean; patch?: string }) {
  const body = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const tail = useRef<THREE.Group>(null);
  const lFL = useRef<THREE.Group>(null), lFR = useRef<THREE.Group>(null), lBL = useRef<THREE.Group>(null), lBR = useRef<THREE.Group>(null);
  const phase = useRef(0);
  useEffect(() => { phase.current = Math.random() * 6; }, []);
  useFrame((_, rawDt) => {
    phase.current += Math.min(rawDt, 0.05) * (walking ? 6 : 1.2);
    if (tail.current) tail.current.rotation.z = 0.35 + Math.sin(phase.current * 1.5) * 0.18;
    // Head life: light bob + slow grazing dips.
    if (head.current) head.current.position.y = Math.sin(phase.current * 0.8) * 0.02 - Math.max(0, Math.sin(phase.current * 0.1)) * 0.1;
    if (!walking) return;
    const s = Math.sin(phase.current) * 0.45;
    if (lFL.current) lFL.current.rotation.z = s;
    if (lBR.current) lBR.current.rotation.z = s;
    if (lFR.current) lFR.current.rotation.z = -s;
    if (lBL.current) lBL.current.rotation.z = -s;
    if (body.current) body.current.position.y = Math.abs(Math.sin(phase.current)) * 0.03;
  });
  const legDefs: [React.RefObject<THREE.Group | null>, number, number][] = [
    [lFL, 0.42, 0.24], [lFR, 0.42, -0.24], [lBL, -0.42, 0.24], [lBR, -0.42, -0.24],
  ];
  return (
    <group position={position} scale={scale} rotation={[0, rotation, 0]}>
      <group ref={body}>
        {/* Rounded body */}
        <RoundedBox args={[1.35, 0.72, 0.72]} radius={0.16} smoothness={3} position={[0, 0.72, 0]} castShadow>
          <meshStandardMaterial color="#efe9e2" roughness={0.9} />
        </RoundedBox>
        {/* Patches */}
        <mesh position={[-0.2, 0.9, 0.37]}><boxGeometry args={[0.5, 0.35, 0.02]} /><meshStandardMaterial color={patch} roughness={0.9} /></mesh>
        <mesh position={[0.15, 0.62, -0.37]}><boxGeometry args={[0.42, 0.32, 0.02]} /><meshStandardMaterial color={patch} roughness={0.9} /></mesh>
        <mesh position={[-0.35, 1.06, 0]}><boxGeometry args={[0.34, 0.02, 0.4]} /><meshStandardMaterial color={patch} roughness={0.9} /></mesh>
        {/* Head (bobs + dips to graze) */}
        <group ref={head}>
        <RoundedBox args={[0.5, 0.5, 0.52]} radius={0.12} smoothness={3} position={[0.82, 0.84, 0]} castShadow>
          <meshStandardMaterial color="#4a3b32" roughness={0.9} />
        </RoundedBox>
        {/* Eyes */}
        {[0.16, -0.16].map((z, i) => (
          <mesh key={i} position={[1.02, 0.98, z]}>
            <sphereGeometry args={[0.05, 8, 8]} />
            <meshStandardMaterial color="#0f0d0c" roughness={0.3} />
          </mesh>
        ))}
        {/* Snout + nostrils */}
        <mesh position={[1.09, 0.72, 0]}>
          <boxGeometry args={[0.2, 0.3, 0.4]} />
          <meshStandardMaterial color="#caa89a" roughness={0.9} />
        </mesh>
        {[0.09, -0.09].map((z, i) => (
          <mesh key={i} position={[1.19, 0.72, z]}>
            <sphereGeometry args={[0.03, 6, 6]} />
            <meshStandardMaterial color="#6b4a44" roughness={0.8} />
          </mesh>
        ))}
        {/* Horns */}
        {[0.16, -0.16].map((z, i) => (
          <mesh key={i} position={[0.86, 1.12, z]} rotation={[z > 0 ? 0.4 : -0.4, 0, 0]}>
            <coneGeometry args={[0.055, 0.22, 6]} />
            <meshStandardMaterial color="#e8dcc0" roughness={0.7} />
          </mesh>
        ))}
        {/* Ears */}
        {[0.32, -0.32].map((z, i) => (
          <mesh key={i} position={[0.76, 1.0, z]} rotation={[0, 0, 0.4]}>
            <sphereGeometry args={[0.1, 6, 6]} />
            <meshStandardMaterial color="#3a2d26" roughness={0.9} />
          </mesh>
        ))}
        </group>
      </group>
      {/* Tail (swishes) */}
      <group ref={tail} position={[-0.66, 0.9, 0]}>
        <mesh position={[0, -0.28, 0]}>
          <cylinderGeometry args={[0.03, 0.02, 0.55, 5]} />
          <meshStandardMaterial color="#4a3b32" roughness={1} />
        </mesh>
        <mesh position={[0, -0.58, 0]}>
          <sphereGeometry args={[0.07, 6, 6]} />
          <meshStandardMaterial color="#2f261f" roughness={1} />
        </mesh>
      </group>
      {legDefs.map(([ref, x, z], i) => (
        <group key={i} ref={ref} position={[x, 0.5, z]}>
          <mesh position={[0, -0.25, 0]}>
            <cylinderGeometry args={[0.085, 0.08, 0.5, 6]} />
            <meshStandardMaterial color="#4a3b32" roughness={1} />
          </mesh>
          <mesh position={[0, -0.5, 0.02]}>
            <cylinderGeometry args={[0.09, 0.09, 0.08, 6]} />
            <meshStandardMaterial color="#1c1512" roughness={0.8} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// Drifting chimney smoke — a few puffs that rise, grow and fade in a loop.
export function Smoke({ position }: { position: Vec3 }) {
  const group = useRef<THREE.Group>(null);
  const N = 4;
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.elapsedTime;
    group.current.children.forEach((child, i) => {
      const phase = (t * 0.4 + i / N) % 1;
      child.position.set(Math.sin(phase * 3 + i) * 0.4, phase * 3, 0);
      child.scale.setScalar(0.2 + phase * 0.5);
      const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
      mat.opacity = (1 - phase) * 0.45;
    });
  });
  return (
    <group ref={group} position={position}>
      {Array.from({ length: N }).map((_, i) => (
        <mesh key={i}>
          <sphereGeometry args={[1, 8, 8]} />
          <meshStandardMaterial color="#dcdcdc" transparent opacity={0.4} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

// A leafy bush — a little cluster of green blobs.
export function Bush({ position, scale = 1 }: { position: Vec3; scale?: number }) {
  const blobs: [number, number, number, number][] = [
    [0, 0.4, 0, 0.5], [0.4, 0.3, 0.05, 0.38], [-0.35, 0.32, -0.1, 0.34], [0.1, 0.55, 0.15, 0.3],
  ];
  return (
    <group position={position} scale={scale}>
      {blobs.map(([x, y, z, r], i) => (
        <mesh key={i} position={[x, y, z]} castShadow>
          <sphereGeometry args={[r, 10, 10]} />
          <meshStandardMaterial color="#4fae5e" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

const FLOWER_COLORS = ["#f472b6", "#fbbf24", "#f87171", "#c084fc", "#ffffff", "#fb7185"];

// A little patch of flowers.
export function Flowers({ position, scale = 1 }: { position: Vec3; scale?: number }) {
  const spots: [number, number, number][] = [
    [0, 0, 0], [0.3, 0.2, 1], [-0.25, 0.15, 2], [0.15, -0.25, 3], [-0.2, -0.2, 4],
  ];
  return (
    <group position={position} scale={scale}>
      {spots.map(([x, z, ci], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, 0.2, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.4, 5]} />
            <meshStandardMaterial color="#3f8f4a" />
          </mesh>
          <mesh position={[0, 0.42, 0]}>
            <sphereGeometry args={[0.1, 8, 8]} />
            <meshStandardMaterial color={FLOWER_COLORS[ci % FLOWER_COLORS.length]} roughness={0.7} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// A faceted grey rock.
export function Rock({ position, scale = 1, rotation = 0 }: { position: Vec3; scale?: number; rotation?: number }) {
  return (
    <group position={position} scale={scale} rotation={[0, rotation, 0]}>
      <mesh scale={[1, 0.7, 1]} castShadow>
        <dodecahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial color="#9a958c" roughness={1} flatShading />
      </mesh>
    </group>
  );
}

// A wooden dock extending from the shore over the water.
export function Dock({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  const posts: [number, number][] = [];
  for (const z of [-4, -1.5, 1, 3.5]) for (const x of [-1.1, 1.1]) posts.push([x, z]);
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[2.8, 0.25, 10]} />
        <meshStandardMaterial color="#9c7a4d" roughness={0.9} />
      </mesh>
      {posts.map(([x, z], i) => (
        <mesh key={i} position={[x, -1, z]}>
          <cylinderGeometry args={[0.14, 0.14, 2.4, 6]} />
          <meshStandardMaterial color="#6b5330" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

// A little sailboat that gently bobs on the water.
export function Boat({ position }: { position: Vec3 }) {
  const g = useRef<THREE.Group>(null);
  const baseY = position[1];
  useFrame((state) => {
    if (!g.current) return;
    const t = state.clock.elapsedTime;
    g.current.position.y = baseY + Math.sin(t * 1.2) * 0.15;
    g.current.rotation.z = Math.sin(t * 1.0) * 0.06;
    g.current.rotation.x = Math.sin(t * 0.8) * 0.04;
  });
  return (
    <group ref={g} position={position}>
      <mesh castShadow>
        <boxGeometry args={[1.4, 0.5, 3]} />
        <meshStandardMaterial color="#8a4b2f" roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.2, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 2, 6]} />
        <meshStandardMaterial color="#5b3a22" />
      </mesh>
      <mesh position={[0, 1.2, 0.35]}>
        <planeGeometry args={[1.1, 1.5]} />
        <meshStandardMaterial color="#f0ead6" side={THREE.DoubleSide} roughness={0.9} />
      </mesh>
    </group>
  );
}

// A windmill with slowly turning sails.
export function Windmill({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  const blades = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (blades.current) blades.current.rotation.z += dt * 0.6;
  });
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Tapered tower */}
      <mesh position={[0, 3, 0]} castShadow>
        <cylinderGeometry args={[1.2, 1.8, 6, 12]} />
        <meshStandardMaterial color="#eae0cf" roughness={0.9} />
      </mesh>
      {/* Cap */}
      <mesh position={[0, 6.5, 0]} castShadow>
        <coneGeometry args={[1.5, 1.4, 12]} />
        <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
      </mesh>
      {/* Sails */}
      <group ref={blades} position={[0, 5.4, 1.6]}>
        {[0, 1, 2, 3].map((k) => (
          <group key={k} rotation={[0, 0, (k * Math.PI) / 2]}>
            <mesh position={[0, 2, 0]} castShadow>
              <boxGeometry args={[0.5, 4, 0.12]} />
              <meshStandardMaterial color="#c96f4a" roughness={0.9} />
            </mesh>
          </group>
        ))}
        <mesh>
          <sphereGeometry args={[0.35, 10, 10]} />
          <meshStandardMaterial color="#5b3a22" />
        </mesh>
      </group>
    </group>
  );
}

// A little market stall — posts, a table with goods, and a striped awning.
export function MarketStall({ position, rotation = 0, awning }: { position: Vec3; rotation?: number; awning: string }) {
  const posts: [number, number][] = [
    [-1, -0.7], [1, -0.7], [-1, 0.7], [1, 0.7],
  ];
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {posts.map(([x, z], i) => (
        <mesh key={i} position={[x, 0.9, z]}>
          <cylinderGeometry args={[0.08, 0.08, 1.8, 6]} />
          <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
        </mesh>
      ))}
      <mesh position={[0, 0.9, 0]}>
        <boxGeometry args={[2.3, 0.15, 1.7]} />
        <meshStandardMaterial color="#a97c50" roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.85, 0]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[2.5, 0.12, 1.9]} />
        <meshStandardMaterial color={awning} roughness={0.85} />
      </mesh>
      {/* goods on the table */}
      <mesh position={[-0.6, 1.08, 0]}>
        <boxGeometry args={[0.3, 0.3, 0.3]} />
        <meshStandardMaterial color="#e07a5f" roughness={0.8} />
      </mesh>
      <mesh position={[0.2, 1.08, 0.3]}>
        <boxGeometry args={[0.26, 0.26, 0.26]} />
        <meshStandardMaterial color="#81b29a" roughness={0.8} />
      </mesh>
      <mesh position={[0.6, 1.06, -0.2]}>
        <sphereGeometry args={[0.16, 8, 8]} />
        <meshStandardMaterial color="#f2cc8f" roughness={0.8} />
      </mesh>
    </group>
  );
}

// A simple wooden bench (front faces +z).
export function Bench({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  const wood = "#a5713f";
  const woodDark = "#8a5a30";
  const frame = "#4a4038";
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Seat slats */}
      {[-0.17, 0, 0.17].map((z, i) => (
        <mesh key={`s${i}`} position={[0, 0.46, z]}>
          <boxGeometry args={[1.7, 0.06, 0.14]} />
          <meshStandardMaterial color={i === 1 ? woodDark : wood} roughness={0.85} />
        </mesh>
      ))}
      {/* Armrests */}
      {[-0.82, 0.82].map((ax) => (
        <group key={ax} position={[ax, 0, 0]}>
          <mesh position={[0, 0.62, 0.02]}>
            <boxGeometry args={[0.07, 0.05, 0.5]} />
            <meshStandardMaterial color={woodDark} roughness={0.85} />
          </mesh>
          <mesh position={[0, 0.53, 0.2]}>
            <boxGeometry args={[0.06, 0.16, 0.06]} />
            <meshStandardMaterial color={frame} roughness={0.8} />
          </mesh>
        </group>
      ))}
      {/* Back slats, tilted back slightly */}
      <group position={[0, 0.52, -0.28]} rotation={[-0.2, 0, 0]}>
        {[0.18, 0.38].map((y, i) => (
          <mesh key={`b${i}`} position={[0, y, 0]}>
            <boxGeometry args={[1.7, 0.13, 0.05]} />
            <meshStandardMaterial color={i === 1 ? wood : woodDark} roughness={0.85} />
          </mesh>
        ))}
        <mesh position={[0, 0.56, 0]}>
          <boxGeometry args={[1.76, 0.07, 0.06]} />
          <meshStandardMaterial color={woodDark} roughness={0.85} />
        </mesh>
      </group>
      {/* Cast-iron side frames: legs + armrests */}
      {[-0.78, 0.78].map((x, i) => (
        <group key={`f${i}`} position={[x, 0, 0]}>
          <mesh position={[0, 0.23, 0.14]}>
            <boxGeometry args={[0.08, 0.46, 0.09]} />
            <meshStandardMaterial color={frame} roughness={0.7} metalness={0.25} />
          </mesh>
          <mesh position={[0, 0.4, -0.22]}>
            <boxGeometry args={[0.08, 0.8, 0.09]} />
            <meshStandardMaterial color={frame} roughness={0.7} metalness={0.25} />
          </mesh>
          <mesh position={[0, 0.66, -0.02]}>
            <boxGeometry args={[0.09, 0.06, 0.5]} />
            <meshStandardMaterial color={frame} roughness={0.7} metalness={0.25} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// A wooden barrel with metal bands.
export function Barrel({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.35, 0.32, 1, 12]} />
        <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
      </mesh>
      {[0.2, 0.8].map((y, i) => (
        <mesh key={i} position={[0, y, 0]}>
          <cylinderGeometry args={[0.37, 0.37, 0.08, 12]} />
          <meshStandardMaterial color="#5a4632" roughness={0.8} metalness={0.2} />
        </mesh>
      ))}
    </group>
  );
}

// A little tuft of grass — a few thin blades, fanned out. Cheap ground texture.
export function GrassTuft({ position, scale = 1, color = "#5aa85f" }: { position: Vec3; scale?: number; color?: string }) {
  const blades: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [0.09, 0.05, 0.2, 1],
    [-0.08, 0.06, -0.24, 2],
    [0.04, -0.08, 0.16, 3],
    [-0.05, -0.05, -0.14, 4],
  ];
  return (
    <group position={position} scale={scale}>
      {blades.map(([x, z, tilt, i]) => (
        <mesh key={i} position={[x, 0.2, z]} rotation={[tilt * 0.4, 0, tilt]}>
          <coneGeometry args={[0.035, 0.42, 4]} />
          <meshStandardMaterial color={color} roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

// A pond lily pad — a two-tone disc with an open blossom: a ring of tilted
// petals around a golden centre.
export function LilyPad({ position, flower = false }: { position: Vec3; flower?: boolean }) {
  return (
    <group position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.4, 12]} />
        <meshStandardMaterial color="#3f9a52" roughness={0.8} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.26, 10]} />
        <meshStandardMaterial color="#4fae62" roughness={0.8} />
      </mesh>
      {flower && (
        <group position={[0, 0.03, 0]}>
          {[0, 1, 2, 3, 4, 5].map((k) => {
            const a = (k / 6) * Math.PI * 2;
            return (
              <mesh key={k} position={[Math.cos(a) * 0.08, 0.05, Math.sin(a) * 0.08]} rotation={[Math.sin(a) * 1.15, 0, -Math.cos(a) * 1.15]}>
                <coneGeometry args={[0.05, 0.16, 5]} />
                <meshStandardMaterial color="#f9cadd" roughness={0.65} />
              </mesh>
            );
          })}
          <mesh position={[0, 0.06, 0]}>
            <sphereGeometry args={[0.05, 8, 8]} />
            <meshStandardMaterial color="#f4c94f" emissive="#c99a2a" emissiveIntensity={0.25} roughness={0.6} />
          </mesh>
        </group>
      )}
    </group>
  );
}

// A waterside cattail clump — stalks of varying heights with brown seed heads,
// golden tips, and arching leaf blades fanned around the base.
export function Reed({ position, scale = 1 }: { position: Vec3; scale?: number }) {
  const stalks: [number, number, number, number][] = [
    // x offset, z offset, lean, height factor
    [-0.12, -0.07, -0.14, 1],
    [0.05, 0.03, 0.04, 0.82],
    [0.14, 0.08, 0.16, 1.08],
    [-0.02, 0.12, -0.05, 0.68],
  ];
  return (
    <group position={position} scale={scale}>
      {stalks.map(([x, z, lean, h], i) => (
        <group key={i} position={[x, 0, z]} rotation={[0, 0, lean]}>
          <mesh position={[0, 0.7 * h, 0]}>
            <cylinderGeometry args={[0.026, 0.038, 1.4 * h, 5]} />
            <meshStandardMaterial color={i % 2 ? "#5a9e4a" : "#6bab55"} roughness={0.9} />
          </mesh>
          {/* Seed head + pale tip */}
          <mesh position={[0, 1.48 * h, 0]}>
            <capsuleGeometry args={[0.06, 0.26, 4, 6]} />
            <meshStandardMaterial color="#7a4a24" roughness={0.95} />
          </mesh>
          <mesh position={[0, 1.72 * h, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.16, 4]} />
            <meshStandardMaterial color="#d9c47a" roughness={0.9} />
          </mesh>
        </group>
      ))}
      {/* Arching leaf blades fanned around the clump */}
      {[0.6, 2.1, 3.5, 5.0].map((a, i) => (
        <mesh key={`lf${i}`} position={[Math.cos(a) * 0.16, 0.42, Math.sin(a) * 0.16]} rotation={[Math.cos(a) * 0.55, -a, Math.sin(a) * 0.55]} scale={[0.5, 1, 0.16]}>
          <coneGeometry args={[0.07, 0.95, 4]} />
          <meshStandardMaterial color="#6fae54" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

// A stone bell tower — a tall village landmark with an arched belfry, a bell and
// a pointed roof. Stands above the treeline as a skyline focal point.
export function BellTower({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  const stone = "#c9c1b0";
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Foundation */}
      <mesh position={[0, 0.2, 0]} castShadow receiveShadow>
        <boxGeometry args={[3, 0.4, 3]} />
        <meshStandardMaterial color="#9c968c" roughness={1} />
      </mesh>
      {/* Shaft */}
      <RoundedBox args={[2.2, 6, 2.2]} radius={0.15} smoothness={3} position={[0, 3.2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={stone} roughness={0.95} />
      </RoundedBox>
      {/* String course under the belfry */}
      <mesh position={[0, 6.4, 0]} castShadow>
        <boxGeometry args={[2.6, 0.4, 2.6]} />
        <meshStandardMaterial color={shade(stone, 0.85)} roughness={0.95} />
      </mesh>
      {/* Belfry */}
      <RoundedBox args={[2.4, 1.8, 2.4]} radius={0.12} smoothness={3} position={[0, 7.5, 0]} castShadow>
        <meshStandardMaterial color={stone} roughness={0.95} />
      </RoundedBox>
      {/* Arch openings on all four faces */}
      {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((a, i) => (
        <mesh key={i} position={[Math.sin(a) * 1.21, 7.5, Math.cos(a) * 1.21]} rotation={[0, a, 0]}>
          <boxGeometry args={[1.0, 1.3, 0.12]} />
          <meshStandardMaterial color="#2a2622" roughness={0.9} />
        </mesh>
      ))}
      {/* Bell hanging in the belfry */}
      <mesh position={[0, 7.35, 0]} castShadow>
        <coneGeometry args={[0.34, 0.5, 10]} />
        <meshStandardMaterial color="#8a6a2a" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Pointed roof */}
      <mesh position={[0, 9.35, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[2.0, 2.2, 4]} />
        <meshStandardMaterial color="#8a3a2a" roughness={0.9} />
      </mesh>
      {/* Gold finial */}
      <mesh position={[0, 10.7, 0]}>
        <sphereGeometry args={[0.16, 8, 8]} />
        <meshStandardMaterial color="#e8c766" metalness={0.4} roughness={0.5} />
      </mesh>
    </group>
  );
}

// A stone well with a little pitched roof and a hanging bucket.
export function Well({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Stone ring */}
      <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.9, 1.0, 1.0, 16]} />
        <meshStandardMaterial color="#9c968c" roughness={1} />
      </mesh>
      <mesh position={[0, 1.02, 0]}>
        <cylinderGeometry args={[0.98, 0.98, 0.14, 16]} />
        <meshStandardMaterial color="#7d766c" roughness={1} />
      </mesh>
      {/* Water */}
      <mesh position={[0, 0.92, 0]}>
        <cylinderGeometry args={[0.72, 0.72, 0.08, 16]} />
        <meshStandardMaterial color="#4a90c2" roughness={0.2} metalness={0.3} />
      </mesh>
      {/* Two posts + a crossbeam */}
      {[-0.8, 0.8].map((x, i) => (
        <mesh key={i} position={[x, 1.7, 0]} castShadow>
          <cylinderGeometry args={[0.08, 0.08, 1.6, 6]} />
          <meshStandardMaterial color="#7a4a24" roughness={0.9} />
        </mesh>
      ))}
      <mesh position={[0, 2.5, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.09, 0.09, 1.9, 8]} />
        <meshStandardMaterial color="#5b3a22" roughness={0.9} />
      </mesh>
      {/* Pitched roof */}
      <mesh position={[0, 2.9, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[1.3, 0.9, 4]} />
        <meshStandardMaterial color="#8a3a2a" roughness={0.9} />
      </mesh>
      {/* Bucket */}
      <mesh position={[0.2, 1.9, 0]}>
        <cylinderGeometry args={[0.17, 0.14, 0.28, 10]} />
        <meshStandardMaterial color="#6b4a2a" roughness={0.9} />
      </mesh>
    </group>
  );
}

// A rolled hay bale.
export function HayBale({ position, rotation = 0, scale = 1 }: { position: Vec3; rotation?: number; scale?: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]} scale={scale}>
      <mesh position={[0, 0.5, 0]} rotation={[0, 0, Math.PI / 2]} receiveShadow>
        <cylinderGeometry args={[0.5, 0.5, 1.1, 16]} />
        <meshStandardMaterial color="#d8b44a" roughness={1} />
      </mesh>
      {/* End cap swirl hint */}
      <mesh position={[0.56, 0.5, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.42, 0.42, 0.02, 16]} />
        <meshStandardMaterial color="#c39f3a" roughness={1} />
      </mesh>
    </group>
  );
}

// A small wooden hand cart.
export function Cart({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Bed */}
      <mesh position={[0, 0.6, 0]}>
        <boxGeometry args={[1.6, 0.16, 0.9]} />
        <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
      </mesh>
      {/* Side rails */}
      {[-0.45, 0.45].map((z, i) => (
        <mesh key={i} position={[0, 0.8, z]}>
          <boxGeometry args={[1.6, 0.28, 0.08]} />
          <meshStandardMaterial color="#7a4a24" roughness={0.9} />
        </mesh>
      ))}
      {/* Wheels */}
      {[-0.5, 0.5].map((x, i) => (
        <mesh key={i} position={[x, 0.32, 0.5]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.34, 0.34, 0.1, 12]} />
          <meshStandardMaterial color="#5b3a22" roughness={0.9} />
        </mesh>
      ))}
      {[-0.5, 0.5].map((x, i) => (
        <mesh key={i} position={[x, 0.32, -0.5]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.34, 0.34, 0.1, 12]} />
          <meshStandardMaterial color="#5b3a22" roughness={0.9} />
        </mesh>
      ))}
      {/* Handles */}
      <mesh position={[0.95, 0.62, 0]} rotation={[0, 0, 0.1]}>
        <boxGeometry args={[0.7, 0.07, 0.07]} />
        <meshStandardMaterial color="#7a4a24" roughness={0.9} />
      </mesh>
    </group>
  );
}

// A fenced vegetable garden — tilled soil, a low post-and-rail fence and rows of
// leafy crops. A cozy farmstead vignette.
export function VeggieGarden({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  const S = 2.6; // half-width
  const posts: Vec3[] = [];
  for (let t = -S; t <= S + 0.01; t += S) {
    posts.push([t, 0, -S], [t, 0, S], [-S, 0, t], [S, 0, t]);
  }
  const crops: [number, number][] = [];
  for (let cx = -1.4; cx <= 1.4; cx += 1.4) {
    for (let cz = -1.4; cz <= 1.4; cz += 0.9) crops.push([cx, cz]);
  }
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Tilled soil */}
      <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[S * 2, S * 2]} />
        <meshStandardMaterial color="#6b4a2a" roughness={1} />
      </mesh>
      {/* Corner + mid posts */}
      {posts.map((p, i) => (
        <mesh key={i} position={[p[0], 0.35, p[2]]}>
          <cylinderGeometry args={[0.07, 0.07, 0.7, 6]} />
          <meshStandardMaterial color="#8a5a2b" roughness={0.9} />
        </mesh>
      ))}
      {/* Rails along the four sides */}
      {[-S, S].map((z, i) => (
        <mesh key={`rz${i}`} position={[0, 0.45, z]}>
          <boxGeometry args={[S * 2, 0.06, 0.06]} />
          <meshStandardMaterial color="#7a4a24" roughness={0.9} />
        </mesh>
      ))}
      {[-S, S].map((x, i) => (
        <mesh key={`rx${i}`} position={[x, 0.45, 0]}>
          <boxGeometry args={[0.06, 0.06, S * 2]} />
          <meshStandardMaterial color="#7a4a24" roughness={0.9} />
        </mesh>
      ))}
      {/* Leafy crops */}
      {crops.map(([cx, cz], i) => (
        <mesh key={`c${i}`} position={[cx, 0.18, cz]}>
          <sphereGeometry args={[0.22, 8, 8]} />
          <meshStandardMaterial color={i % 4 === 0 ? "#c94f4f" : "#5aa356"} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

// A classic red barn — a big farm building with white corner trim, a wide roof,
// tall double doors with a white X-brace, and a round hayloft window. Adds a
// distinct silhouette next to the cottages.
export function Barn({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  const w = 6.5, d = 4.6, h = 3.4;
  const red = "#a3352e", trim = "#eee7db";
  const roofH = Math.max(w, d) * 0.5;
  const df = d / 2 + 0.03; // door face
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Foundation */}
      <mesh position={[0, 0.15, 0]} castShadow receiveShadow>
        <boxGeometry args={[w + 0.3, 0.3, d + 0.3]} />
        <meshStandardMaterial color="#9c968c" roughness={1} />
      </mesh>
      {/* Body */}
      <mesh position={[0, h / 2 + 0.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={red} roughness={0.9} />
      </mesh>
      {/* Wide pyramid roof */}
      <mesh position={[0, h + 0.3 + roofH / 2, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[Math.max(w, d) * 0.8, roofH, 4]} />
        <meshStandardMaterial color="#7a2a22" roughness={0.95} />
      </mesh>
      {/* White corner trim boards */}
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} position={[(sx * w) / 2, h / 2 + 0.3, (sz * d) / 2]}>
          <boxGeometry args={[0.2, h, 0.2]} />
          <meshStandardMaterial color={trim} roughness={0.9} />
        </mesh>
      ))}
      {/* Double doors */}
      <mesh position={[0, 1.7, df]}>
        <boxGeometry args={[2.6, 2.8, 0.1]} />
        <meshStandardMaterial color="#7a4a24" roughness={0.9} />
      </mesh>
      {/* White door frame */}
      <mesh position={[0, 3.12, df + 0.03]}>
        <boxGeometry args={[2.9, 0.18, 0.08]} />
        <meshStandardMaterial color={trim} roughness={0.9} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 1.35, 1.72, df + 0.03]}>
          <boxGeometry args={[0.18, 2.9, 0.08]} />
          <meshStandardMaterial color={trim} roughness={0.9} />
        </mesh>
      ))}
      {/* Centre split + white X-brace */}
      <mesh position={[0, 1.7, df + 0.05]}>
        <boxGeometry args={[0.12, 2.8, 0.06]} />
        <meshStandardMaterial color={trim} roughness={0.9} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, 1.7, df + 0.06]} rotation={[0, 0, s * 0.75]}>
          <boxGeometry args={[0.12, 3.5, 0.05]} />
          <meshStandardMaterial color={trim} roughness={0.9} />
        </mesh>
      ))}
      {/* Round hayloft window high on the gable */}
      <mesh position={[0, h + 0.1, df]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.44, 0.44, 0.08, 14]} />
        <meshStandardMaterial color={trim} roughness={0.9} />
      </mesh>
      <mesh position={[0, h + 0.1, df + 0.05]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.32, 0.32, 0.08, 14]} />
        <meshStandardMaterial color="#2a2622" roughness={0.9} />
      </mesh>
    </group>
  );
}

// A little sailboat — a wooden hull, a mast, a triangular main sail, a small jib
// and a pennant flag. Meant to drift across the open sea (motion handled by the
// scene manager).
export function Sailboat() {
  const mainSail = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(0, 2.6);
    s.lineTo(1.7, 0);
    s.closePath();
    return s;
  }, []);
  const jib = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(0, 1.9);
    s.lineTo(-1.1, 0);
    s.closePath();
    return s;
  }, []);
  return (
    <group>
      {/* Hull */}
      <mesh position={[0, 0.25, 0]} castShadow>
        <boxGeometry args={[3.2, 0.5, 1.1]} />
        <meshStandardMaterial color="#7a4a24" roughness={0.9} />
      </mesh>
      {/* Bow wedge */}
      <mesh position={[1.75, 0.25, 0]} rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[0.8, 0.5, 0.8]} />
        <meshStandardMaterial color="#7a4a24" roughness={0.9} />
      </mesh>
      {/* Rim highlight */}
      <mesh position={[0, 0.52, 0]}>
        <boxGeometry args={[3.2, 0.08, 1.15]} />
        <meshStandardMaterial color="#5b3a22" roughness={0.9} />
      </mesh>
      {/* Mast */}
      <mesh position={[0.1, 1.9, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.07, 3.4, 8]} />
        <meshStandardMaterial color="#5b3a22" roughness={0.9} />
      </mesh>
      {/* Main sail */}
      <mesh position={[0, 0.6, 0]} rotation={[0, Math.PI / 2, 0]}>
        <shapeGeometry args={[mainSail]} />
        <meshStandardMaterial color="#f4f1ea" roughness={0.8} side={THREE.DoubleSide} />
      </mesh>
      {/* Jib (front sail) */}
      <mesh position={[0.1, 0.6, 0]} rotation={[0, Math.PI / 2, 0]}>
        <shapeGeometry args={[jib]} />
        <meshStandardMaterial color="#e8e2d6" roughness={0.8} side={THREE.DoubleSide} />
      </mesh>
      {/* Pennant flag */}
      <mesh position={[0.1, 3.55, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[0.6, 0.24]} />
        <meshStandardMaterial color="#e07a5f" roughness={0.8} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
