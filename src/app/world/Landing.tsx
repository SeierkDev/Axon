"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { dayPhase, nightFactor } from "./dayCycle";
import { EffectComposer, Bloom, Vignette, N8AO, HueSaturation, BrightnessContrast, SMAA } from "@react-three/postprocessing";
import { Sun, Cloud, Tree, House, Sheep, Cow, Bush, Flowers, Rock, Dock, Boat, Windmill, Villager, LampPost, Butterfly, MarketStall, Bench, Barrel, GrassTuft, LilyPad, Reed, BellTower, Well, HayBale, Cart, VeggieGarden, Barn, Sailboat } from "./decor";
import { OpenWorld, type OpenPlot } from "./OpenWorld";

const SHIRT = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#f97316", "#14b8a6"];
const HAIR = ["#2b1d12", "#4a3419", "#6b4a2a", "#1a1a1a", "#8a6a3a", "#a03a2a", "#c9a24a"];
const SKIN = ["#f1c9a5", "#e8b48c", "#d69a6e", "#b87a50", "#8a5a3a"];
const HAT = ["#7c4a2a", "#3a6b4a", "#8a3a3a", "#2a4a7a"];
const BFLY = ["#f472b6", "#fbbf24", "#a855f7", "#60a5fa", "#fb7185"];

type Vec3 = [number, number, number];

// Friendly village palettes — soft, warm walls with warm/terracotta roofs.
const WALL = [
  "#f2e6c9", "#e7b596", "#a9c9a0", "#a6cfe6", "#f4d58d",
  "#e2a6bb", "#c9b6e8", "#f5c6a5", "#9fd6c2", "#f0a6a0",
];
const ROOF = ["#c0563e", "#8a5a2b", "#3f7d7a", "#b5462f", "#5a4632", "#c77d3a"];

// Deterministic pseudo-random so the scene is stable between renders.
function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const ZONE = 26; // village content radius
export const ISLAND_RADIUS = 30;
const WATER_Y = -1.7;
const PATH_ANGLES = [0.4, 1.5, 2.7, 3.8, 5.1];

// True if a point (plus a `pad` footprint radius) would overlap the central plaza
// or a radial dirt path — used to keep trees, houses and props off the roads.
// pad accounts for the object's own size (tree canopy, house half-width, etc.).
function onRoad(x: number, z: number, pad = 0): boolean {
  if (Math.hypot(x, z) < 6.8 + pad) return true; // plaza
  for (const a of PATH_ANGLES) {
    const along = x * Math.cos(a) + z * Math.sin(a); // distance along the path
    const perp = -x * Math.sin(a) + z * Math.cos(a); // sideways offset from the path
    if (Math.abs(perp) < 1.4 + pad && along > 3 && along < 27.5) return true;
  }
  return false;
}

// The sea — a big plane with gentle animated waves and a shallow→deep colour
// gradient (lighter near the island, darker out to the horizon).
function Ocean() {
  const geo = useMemo(() => {
    // Fewer segments than before — cheaper per-frame wave + normal recompute.
    const g = new THREE.PlaneGeometry(700, 700, 32, 32);
    const shallow = new THREE.Color("#5cb4dd");
    const deep = new THREE.Color("#2c6690");
    const pos = g.attributes.position;
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const dist = Math.hypot(pos.getX(i), pos.getY(i));
      const c = shallow.clone().lerp(deep, Math.min(1, dist / 130));
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }, []);
  const frame = useRef(0);

  /* eslint-disable react-hooks/immutability */
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      pos.setZ(i, Math.sin(x * 0.04 + t) * 0.3 + Math.sin(y * 0.05 + t * 0.8) * 0.3);
    }
    pos.needsUpdate = true;
    // Recompute normals only every other frame — halves the heaviest CPU cost.
    if (frame.current++ % 2 === 0) geo.computeVertexNormals();
  });
  /* eslint-enable react-hooks/immutability */

  return (
    <mesh geometry={geo} position={[0, WATER_Y, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.35} metalness={0.15} />
    </mesh>
  );
}

// White foam where the sea meets the beach.
function Foam() {
  return (
    <mesh position={[0, WATER_Y + 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[ISLAND_RADIUS + 1.5, ISLAND_RADIUS + 4, 72]} />
      <meshStandardMaterial color="#eef6fb" transparent opacity={0.55} roughness={1} />
    </mesh>
  );
}

// Horizon tone — a soft mid light-blue (NOT near-white) so the sea/sky seam
// doesn't spike into a bright band.
const HORIZON_COLOR = "#9fc6e2";

// ── Day/night cycle ───────────────────────────────────────────────────────────
//
// One full day every 20 minutes, driven per-frame by mutating light/sky refs —
// zero React re-renders. Phase 0 = midnight, 0.25 = sunrise, 0.5 = noon,
// 0.75 = sunset. The world opens in the familiar golden hour.

// Tiny deterministic PRNG (same as OpenWorld's) — star placement must be pure.
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Keyframes around the clock. Values between stops are linearly blended.
interface DayKey {
  p: number;
  top: string; // sky gradient stops
  mid: string;
  hor: string;
  sun: number; // directional intensity
  sunCol: string;
  amb: number; // ambient intensity
  hemi: number; // hemisphere intensity
}
const DAY_KEYS: DayKey[] = [
  { p: 0.0, top: "#0c1322", mid: "#131c31", hor: "#1b2640", sun: 0.22, sunCol: "#93a7cc", amb: 0.14, hemi: 0.1 },
  { p: 0.2, top: "#0c1322", mid: "#131c31", hor: "#1b2640", sun: 0.22, sunCol: "#93a7cc", amb: 0.14, hemi: 0.1 },
  { p: 0.27, top: "#37507e", mid: "#7d6f92", hor: "#e89a63", sun: 0.6, sunCol: "#ffb27a", amb: 0.22, hemi: 0.3 },
  { p: 0.34, top: "#4f8ec0", mid: "#79aad4", hor: "#a5c8e0", sun: 1.0, sunCol: "#ffe9bd", amb: 0.3, hemi: 0.46 },
  { p: 0.5, top: "#5f9fce", mid: "#82b2da", hor: "#9fc6e2", sun: 1.2, sunCol: "#fff0d2", amb: 0.32, hemi: 0.52 },
  { p: 0.63, top: "#5f9fce", mid: "#82b2da", hor: "#9fc6e2", sun: 1.15, sunCol: "#ffd89a", amb: 0.3, hemi: 0.5 },
  { p: 0.73, top: "#3e5480", mid: "#9a6a80", hor: "#f0955f", sun: 0.62, sunCol: "#ff9a5e", amb: 0.22, hemi: 0.28 },
  { p: 0.8, top: "#0c1322", mid: "#131c31", hor: "#1b2640", sun: 0.22, sunCol: "#93a7cc", amb: 0.14, hemi: 0.1 },
  { p: 1.0, top: "#0c1322", mid: "#131c31", hor: "#1b2640", sun: 0.22, sunCol: "#93a7cc", amb: 0.14, hemi: 0.1 },
];

const _ca = new THREE.Color();
const _cb = new THREE.Color();
function lerpDay(p: number): { top: THREE.Color; mid: THREE.Color; hor: THREE.Color; sun: number; sunCol: THREE.Color; amb: number; hemi: number } {
  let i = 0;
  while (i < DAY_KEYS.length - 2 && DAY_KEYS[i + 1].p < p) i++;
  const a = DAY_KEYS[i];
  const b = DAY_KEYS[i + 1];
  const f = Math.min(1, Math.max(0, (p - a.p) / Math.max(1e-6, b.p - a.p)));
  const col = (ka: string, kb: string) => _ca.set(ka).clone().lerp(_cb.set(kb), f);
  return {
    top: col(a.top, b.top),
    mid: col(a.mid, b.mid),
    hor: col(a.hor, b.hor),
    sun: a.sun + (b.sun - a.sun) * f,
    sunCol: col(a.sunCol, b.sunCol),
    amb: a.amb + (b.amb - a.amb) * f,
    hemi: a.hemi + (b.hemi - a.hemi) * f,
  };
}

// A shooting star: every half-minute or so at night, a bright streak crosses
// a random patch of sky for under a second. One mesh, recycled.
function ShootingStars() {
  const m = useRef<THREE.Mesh>(null);
  const st = useRef({ wait: 18, t: -1, x0: 0, y0: 0, z0: 0, dx: 0, dy: 0 });
  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const mesh = m.current;
    if (!mesh) return;
    const s = st.current;
    if (s.t < 0) {
      s.wait -= dt;
      if (s.wait <= 0) {
        if (nightFactor(state.clock.elapsedTime) > 0.55) {
          s.t = 0;
          s.x0 = (Math.random() - 0.5) * 520;
          s.y0 = 150 + Math.random() * 90;
          s.z0 = (Math.random() - 0.5) * 520;
          s.dx = (Math.random() < 0.5 ? -1 : 1) * (140 + Math.random() * 90);
          s.dy = -(50 + Math.random() * 40);
        }
        s.wait = 22 + Math.random() * 40;
      }
      return;
    }
    s.t += dt;
    const f = s.t / 0.85;
    if (f >= 1) {
      s.t = -1;
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.position.set(s.x0 + s.dx * f, s.y0 + s.dy * f, s.z0);
    mesh.rotation.z = Math.atan2(s.dy, s.dx);
    (mesh.material as THREE.MeshBasicMaterial).opacity = Math.sin(f * Math.PI) * 0.95;
  });
  return (
    <mesh ref={m} visible={false}>
      <boxGeometry args={[7, 0.14, 0.14]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

// The whole moving sky: sun + moon arcs, keyframed light, live sky gradient,
// fog colour and a star field that fades in at night.
function DayNight({ shadowExtent, sea, followRef, shadows = true }: { shadowExtent: number; sea: boolean; followRef?: React.RefObject<{ x: number; z: number }>; shadows?: boolean }) {
  // With a follow target, the shadow camera shrinks to a tight box around the
  // player — crisper shadows AND a fraction of the shadow-pass cost.
  const span = followRef ? 42 : shadowExtent;
  const lightTarget = useMemo(() => new THREE.Object3D(), []);
  const scene = useThree((st) => st.scene);
  const dir = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const amb = useRef<THREE.AmbientLight>(null);
  const sunGrp = useRef<THREE.Group>(null);
  const moonGrp = useRef<THREE.Group>(null);
  const starMat = useRef<THREE.PointsMaterial>(null);
  const lastSky = useRef(-1);

  // Sky gradient canvas — redrawn only when the palette meaningfully moves.
  const sky = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { canvas, tex };
  }, []);
  useEffect(() => {
    /* eslint-disable react-hooks/immutability */
    scene.background = sky.tex;
    return () => {
      scene.background = null;
      sky.tex.dispose();
    };
    /* eslint-enable react-hooks/immutability */
  }, [scene, sky]);

  const stars = useMemo(() => {
    const r = mulberry(0x57a125);
    const n = 260;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const el = 0.12 + r() * 1.35;
      const rad = 430;
      pos[i * 3] = Math.cos(a) * Math.cos(el) * rad;
      pos[i * 3 + 1] = Math.sin(el) * rad;
      pos[i * 3 + 2] = Math.sin(a) * Math.cos(el) * rad;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);

  // eslint-disable-next-line react-hooks/immutability -- three.js refs are mutated per frame by design
  useFrame((state) => {
    const p = dayPhase(state.clock.elapsedTime);
    const k = lerpDay(p);
    const theta = (p - 0.25) * Math.PI * 2; // sun angle: 0 at sunrise
    const R = shadowExtent * 1.05;
    const sunY = Math.sin(theta);
    const sunX = Math.cos(theta);
    const night = Math.max(0, Math.min(1, -sunY * 2 + 0.25));

    if (dir.current) {
      // Above the horizon it IS the sun; at night the moon takes the same rig,
      // opposite side of the sky.
      const up = sunY > -0.08;
      const y = up ? Math.max(0.12, sunY) : Math.max(0.18, -sunY);
      const x = up ? sunX : -sunX;
      const fp = followRef?.current;
      const bx = fp ? fp.x : 0;
      const bz = fp ? fp.z : 0;
      const LR = fp ? 58 : R;
      dir.current.position.set(bx + x * LR * 0.9, y * LR, bz - LR * 0.12);
      if (fp) {
        lightTarget.position.set(bx, 0, bz);
        lightTarget.updateMatrixWorld();
      }
      dir.current.intensity = k.sun;
      dir.current.color.copy(k.sunCol);
    }
    if (hemi.current) hemi.current.intensity = k.hemi;
    if (amb.current) amb.current.intensity = k.amb;
    if (sunGrp.current) {
      sunGrp.current.position.set(sunX * 300, sunY * 220, -140);
      sunGrp.current.visible = sunY > -0.12;
    }
    if (moonGrp.current) {
      moonGrp.current.position.set(-sunX * 300, -sunY * 220, -140);
      moonGrp.current.visible = -sunY > -0.12;
    }
    if (starMat.current) starMat.current.opacity = night * 0.9;
    if (scene.fog instanceof THREE.Fog) scene.fog.color.copy(k.hor);

    // Sky texture — every ~0.4% of the day (≈5s) is smooth to the eye.
    if (Math.abs(p - lastSky.current) > 0.004) {
      lastSky.current = p;
      const ctx = sky.canvas.getContext("2d");
      if (ctx) {
        const g = ctx.createLinearGradient(0, 0, 0, 256);
        g.addColorStop(0, `#${k.top.getHexString()}`);
        g.addColorStop(0.55, `#${k.mid.getHexString()}`);
        g.addColorStop(1, `#${k.hor.getHexString()}`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 4, 256);
        // eslint-disable-next-line react-hooks/immutability -- CanvasTexture upload flag
        sky.tex.needsUpdate = true;
      }
    }
  });

  return (
    <>
      <fog attach="fog" args={[HORIZON_COLOR, sea ? 95 : 140, sea ? 340 : 520]} />
      <hemisphereLight ref={hemi} args={["#dbeeff", "#8a8a55", 0.5]} />
      <ambientLight ref={amb} intensity={0.3} />
      <directionalLight
        ref={dir}
        color="#ffd89a"
        position={[shadowExtent * 0.6, shadowExtent * 0.9, -shadowExtent * 0.1]}
        intensity={1.15}
        castShadow={shadows}
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0001}
        shadow-normalBias={0.04}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
        shadow-camera-far={span * 4}
        target={lightTarget}
      />
      <primitive object={lightTarget} />
      <group ref={sunGrp}>
        <Sun position={[0, 0, 0]} />
      </group>
      <group ref={moonGrp} visible={false}>
        <mesh>
          <sphereGeometry args={[4.5, 24, 24]} />
          <meshBasicMaterial color="#e8ecf5" toneMapped={false} />
        </mesh>
        {/* maria — the grey seas that make it read as THE moon */}
        {([[1.4, 1.2, 3.9, 1.1], [-1.7, 0.4, 3.9, 0.8], [0.3, -1.6, 3.95, 0.65], [-0.6, 1.9, 3.85, 0.55]] as const).map(([mx, my, mz, mr], i) => (
          <mesh key={i} position={[mx, my, mz]}>
            <sphereGeometry args={[mr, 12, 12]} />
            <meshBasicMaterial color="#c2cadd" toneMapped={false} />
          </mesh>
        ))}
        <mesh>
          <sphereGeometry args={[7, 20, 20]} />
          <meshBasicMaterial color="#c8d2ea" transparent opacity={0.16} toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[9.5, 18, 18]} />
          <meshBasicMaterial color="#aebadd" transparent opacity={0.07} toneMapped={false} />
        </mesh>
      </group>
      <ShootingStars />
      <points geometry={stars}>
        <pointsMaterial ref={starMat} color="#e8eefc" size={1.6} sizeAttenuation={false} transparent opacity={0} depthWrite={false} />
      </points>
    </>
  );
}


// A stone fountain crowned with a softly glowing "Axon node" — the village's heart
// and a nod to the network hub. Sits at the centre of the plaza.
function Fountain() {
  const halo = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (halo.current) halo.current.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 1.5) * 0.12);
  });
  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 0.4, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[2, 2.15, 0.8, 28]} />
        <meshStandardMaterial color="#b9b1a1" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.82, 0]}>
        <cylinderGeometry args={[1.75, 1.75, 0.12, 28]} />
        <meshStandardMaterial color="#5bb8e0" roughness={0.3} metalness={0.1} />
      </mesh>
      <mesh position={[0, 1.5, 0]} castShadow>
        <cylinderGeometry args={[0.3, 0.38, 1.6, 12]} />
        <meshStandardMaterial color="#cbc3b3" roughness={0.9} />
      </mesh>
      <mesh position={[0, 2.6, 0]}>
        <sphereGeometry args={[0.55, 20, 20]} />
        <meshStandardMaterial color="#34d399" emissive="#34d399" emissiveIntensity={1.2} roughness={0.3} toneMapped={false} />
      </mesh>
      <mesh ref={halo} position={[0, 2.6, 0]}>
        <sphereGeometry args={[0.85, 16, 16]} />
        <meshBasicMaterial color="#6ee7b7" transparent opacity={0.22} toneMapped={false} />
      </mesh>
    </group>
  );
}

// A small flock of birds gliding in slow circles overhead, wings gently flapping.
function Birds() {
  const group = useRef<THREE.Group>(null);
  const birds = useMemo(
    () =>
      Array.from({ length: 6 }).map((_, i) => ({
        radius: 20 + i * 3.5,
        height: 30 + (i % 3) * 5,
        speed: 0.14 + i * 0.015,
        phase: i * 1.05,
        size: 0.8 + (i % 2) * 0.35,
      })),
    []
  );
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.elapsedTime;
    group.current.children.forEach((child, i) => {
      const b = birds[i];
      const a = t * b.speed + b.phase;
      child.position.set(Math.cos(a) * b.radius, b.height + Math.sin(a * 2) * 1.5, Math.sin(a) * b.radius);
      child.rotation.y = -a;
      const flap = Math.sin(t * 8 + b.phase) * 0.5;
      if (child.children[0]) child.children[0].rotation.z = 0.2 + flap;
      if (child.children[1]) child.children[1].rotation.z = -0.2 - flap;
    });
  });
  return (
    <group ref={group}>
      {birds.map((b, i) => (
        <group key={i} scale={b.size}>
          {/* wings pivot at the body */}
          <group>
            <mesh position={[0.35, 0, 0]}>
              <boxGeometry args={[0.7, 0.04, 0.28]} />
              <meshStandardMaterial color="#2b2b2b" />
            </mesh>
          </group>
          <group>
            <mesh position={[-0.35, 0, 0]}>
              <boxGeometry args={[0.7, 0.04, 0.28]} />
              <meshStandardMaterial color="#2b2b2b" />
            </mesh>
          </group>
          <mesh>
            <boxGeometry args={[0.18, 0.14, 0.4]} />
            <meshStandardMaterial color="#333333" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// Villagers (the agents) wandering the island in gentle loops, with a walking bob.
function Villagers() {
  const group = useRef<THREE.Group>(null);
  const people = useMemo(() => {
    const r = rng(555);
    return Array.from({ length: 16 }).map(() => {
      const ca = r() * Math.PI * 2;
      const cr = 3 + r() * 17;
      return {
        cx: Math.cos(ca) * cr,
        cz: Math.sin(ca) * cr,
        radius: 2 + r() * 5,
        speed: (0.15 + r() * 0.2) * (r() < 0.5 ? 1 : -1),
        phase: r() * Math.PI * 2,
        bob: 4 + r() * 3,
        shirt: SHIRT[Math.floor(r() * SHIRT.length)],
        hair: HAIR[Math.floor(r() * HAIR.length)],
        skin: SKIN[Math.floor(r() * SKIN.length)],
        hat: r() < 0.25 ? HAT[Math.floor(r() * HAT.length)] : undefined,
      };
    });
  }, []);
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.elapsedTime;
    group.current.children.forEach((child, i) => {
      const p = people[i];
      const a = t * p.speed + p.phase;
      child.position.set(p.cx + Math.cos(a) * p.radius, 0, p.cz + Math.sin(a) * p.radius);
      child.rotation.y = -a + (p.speed > 0 ? Math.PI / 2 : -Math.PI / 2);
    });
  });
  return (
    <group ref={group}>
      {people.map((p, i) => (
        <Villager key={i} shirt={p.shirt} hair={p.hair} skin={p.skin} hat={p.hat} walking />
      ))}
    </group>
  );
}

// Butterflies fluttering low over the village near the flowers.
function Butterflies() {
  const group = useRef<THREE.Group>(null);
  const flies = useMemo(() => {
    const r = rng(777);
    return Array.from({ length: 10 }).map(() => {
      const ca = r() * Math.PI * 2;
      const cr = 4 + r() * 18;
      return {
        cx: Math.cos(ca) * cr,
        cz: Math.sin(ca) * cr,
        radius: 1.5 + r() * 3,
        speed: (0.6 + r() * 0.6) * (r() < 0.5 ? 1 : -1),
        phase: r() * Math.PI * 2,
        height: 1.2 + r() * 1.6,
        color: BFLY[Math.floor(r() * BFLY.length)],
      };
    });
  }, []);
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.elapsedTime;
    group.current.children.forEach((child, i) => {
      const f = flies[i];
      const a = t * f.speed + f.phase;
      child.position.set(f.cx + Math.cos(a) * f.radius, f.height + Math.sin(t * 3 + f.phase) * 0.4, f.cz + Math.sin(a) * f.radius);
      child.rotation.y = -a;
      child.scale.x = 0.45 + Math.abs(Math.sin(t * 15 + f.phase)) * 0.55; // wing flap
    });
  });
  return (
    <group ref={group}>
      {flies.map((f, i) => (
        <Butterfly key={i} color={f.color} />
      ))}
    </group>
  );
}

// Glowing fireflies drifting near the fountain (they bloom in post-processing).
function Fireflies() {
  const group = useRef<THREE.Group>(null);
  const flies = useMemo(() => {
    const r = rng(999);
    return Array.from({ length: 16 }).map(() => ({
      cx: (r() - 0.5) * 10,
      cz: (r() - 0.5) * 10,
      radius: 1 + r() * 3,
      speed: (0.3 + r() * 0.4) * (r() < 0.5 ? 1 : -1),
      phase: r() * Math.PI * 2,
      height: 1 + r() * 3,
      bob: 1 + r() * 2,
    }));
  }, []);
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.elapsedTime;
    group.current.children.forEach((child, i) => {
      const f = flies[i];
      const a = t * f.speed + f.phase;
      child.position.set(f.cx + Math.cos(a) * f.radius, f.height + Math.sin(t * f.bob + f.phase) * 0.6, f.cz + Math.sin(a) * f.radius);
      child.scale.setScalar(0.6 + Math.abs(Math.sin(t * 3 + f.phase)) * 0.8);
    });
  });
  return (
    <group ref={group}>
      {flies.map((_, i) => (
        <mesh key={i}>
          <sphereGeometry args={[0.09, 8, 8]} />
          <meshBasicMaterial color="#eaff8a" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

// A slowly rotating grassy island village — cottages spread on a loose grid so
// nothing overlaps, dirt paths radiating from a central plaza + fountain, trees in
// the gaps, sheep and cows grazing, a sandy beach and the sea around it.
export type Collider = { x: number; z: number; r: number };
// An interactable building in the village — each house maps to a real agent in
// the walkable world (10.3).
export type WorldBuilding = { key: string; x: number; z: number; rot?: number; w?: number; peak?: number };

export function Village({
  lowPower = false,
  walkable = false,
  onSolids,
  onBuildings,
}: {
  lowPower?: boolean;
  walkable?: boolean;
  onSolids?: (solids: Collider[]) => void;
  onBuildings?: (buildings: WorldBuilding[]) => void;
}) {
  const group = useRef<THREE.Group>(null);

  const { houses, trees, animals, paths, bushes, flowers, rocks, patches, grass, pathStones, lilies, reeds, cobbles, solids } = useMemo(() => {
    const r = rng(1337);
    const treeVariant = (): "round" | "pine" | "blossom" | "autumn" => {
      const rr = r();
      return rr < 0.24 ? "pine" : rr < 0.38 ? "blossom" : rr < 0.5 ? "autumn" : "round";
    };
    const houses: { pos: Vec3; w: number; d: number; h: number; wall: string; roof: string; rot: number; chimney: boolean; wing: boolean; porch: boolean; dormer: boolean }[] = [];
    const trees: { pos: Vec3; s: number; variant: "round" | "pine" | "blossom" | "autumn"; rot: number }[] = [];
    const animals: { pos: Vec3; s: number; rot: number; kind: "sheep" | "cow" }[] = [];
    const bushes: { pos: Vec3; s: number }[] = [];
    const flowers: { pos: Vec3; s: number }[] = [];
    const rocks: { pos: Vec3; s: number; rot: number }[] = [];

    // Collision system: nothing overlaps a road or a previously-placed object.
    // Each entry is a footprint circle {x, z, r}; `fits` rejects a spot that
    // clips any of them, `claim` records a new one.
    const placed: { x: number; z: number; r: number }[] = [];
    const fits = (x: number, z: number, rad: number): boolean => {
      if (onRoad(x, z, rad)) return false;
      for (const p of placed) if (Math.hypot(x - p.x, z - p.z) < rad + p.r) return false;
      return true;
    };
    const claim = (x: number, z: number, rad: number) => placed.push({ x, z, r: rad });

    // Solid, walk-into-able structures — the subset of colliders a walking player
    // should bump into (buildings + landmarks). Ground radii are a touch tighter
    // than the placement footprint so you can get close; tall things like the
    // windmill use a small base radius (the blades are overhead).
    const solids: Collider[] = [
      { x: -15, z: 14, r: 3.0 }, // windmill base
      { x: 15.5, z: -12.6, r: 2.2 }, // bell tower
      { x: 7.5, z: -1, r: 1.8 }, // market stall
      { x: -6.5, z: 4, r: 1.8 }, // market stall
      { x: 7, z: 6, r: 1.3 }, // well
      { x: 10, z: -2, r: 1.2 }, // cart
      { x: -3.9, z: -14.5, r: 2.8 }, // vegetable garden
      { x: -21, z: 4, r: 3.6 }, // barn
    ];

    // Seed the collision list with the fixed, hand-placed props (windmill, market
    // stalls, lamp posts) so generated trees/houses never grow into them. These
    // coordinates must match the JSX below.
    claim(-15, 14, 4.6); // windmill — wide because of the sweeping blades
    claim(15.5, -12.6, 3.5); // bell tower landmark
    claim(7.5, -1, 2.4); // market stall (+ its barrels)
    claim(-6.5, 4, 2.4); // market stall (+ its barrel)
    claim(7, 6, 1.8); // well
    claim(10, -2, 1.4); // cart
    claim(-10.5, 17.5, 2.4); // hay bales by the windmill
    claim(-3.9, -14.5, 3.9); // fenced vegetable garden
    claim(-21, 4, 4.6); // red barn (farm corner)
    for (const a of PATH_ANGLES) {
      for (const rad of [8, 20]) {
        claim(Math.cos(a) * rad + 1.6, Math.sin(a) * rad + 1.6, 1.0); // lamp posts
      }
    }
    // Try `tries` spots around a target angle within an annulus; place on first fit.
    const spread = (baseA: number, spanA: number, rMin: number, rMax: number, rad: number, tries: number): Vec3 | null => {
      for (let t = 0; t < tries; t++) {
        const a = baseA + (r() - 0.5) * spanA;
        const rr = rMin + r() * (rMax - rMin);
        const x = Math.cos(a) * rr;
        const z = Math.sin(a) * rr;
        if (fits(x, z, rad)) { claim(x, z, rad); return [x, 0, z]; }
      }
      return null;
    };

    // Houses first — they anchor the village. Even angular ring so they surround
    // the plaza rather than bunching, each facing the centre.
    const HOUSE_N = 11;
    for (let i = 0; i < HOUSE_N; i++) {
      const baseA = (i / HOUSE_N) * Math.PI * 2;
      const w = 3.5 + r() * 1.6;
      const d = 3.5 + r() * 1.6;
      // Footprint covers the roof overhang and a possible L-wing (+ breathing room).
      const rad = Math.max(w, d) * 0.7 + 1.8;
      const pos = spread(baseA, (Math.PI * 2) / HOUSE_N * 0.7, 10, ZONE - 2, rad, 14);
      if (!pos) continue;
      houses.push({
        pos,
        w,
        d,
        h: 2.6 + r() * 2,
        wall: WALL[Math.floor(r() * WALL.length)],
        roof: ROOF[Math.floor(r() * ROOF.length)],
        // Face the door toward the plaza (small jitter) so the village reads as
        // coherent instead of houses pointing every direction.
        rot: Math.atan2(-pos[0], -pos[2]) + (r() - 0.5) * 0.3,
        chimney: r() < 0.65,
        wing: r() < 0.35,
        porch: r() < 0.4,
        dormer: r() < 0.3,
      });
      // House body is a solid; walk radius a bit tighter than the placement pad.
      solids.push({ x: pos[0], z: pos[2], r: Math.max(w, d) * 0.5 + 0.6 });
    }

    // Interior trees — one per angular bucket so foliage rings the whole island
    // evenly instead of clustering on one side. Collision-checked, so no two
    // trees grow into each other.
    // Footprint of a tree ≈ its canopy radius, which scales with the tree. Sizing
    // the collision circle to the real canopy is what stops crowns overlapping.
    const canopyR = (s: number) => 1.7 * s + 0.3;
    const TREE_N = 30;
    for (let i = 0; i < TREE_N; i++) {
      const baseA = (i / TREE_N) * Math.PI * 2;
      const s = 0.9 + r() * 0.8;
      const pos = spread(baseA, (Math.PI * 2) / TREE_N * 1.6, 9, ZONE, canopyR(s), 14);
      if (!pos) continue;
      trees.push({ pos, s, variant: treeVariant(), rot: r() * Math.PI * 2 });
    }

    // A ring of trees hugging the shoreline, evenly spaced by angle.
    const PERIM_N = 22;
    for (let i = 0; i < PERIM_N; i++) {
      const baseA = (i / PERIM_N) * Math.PI * 2;
      const s = 0.9 + r() * 0.6;
      const pos = spread(baseA, (Math.PI * 2) / PERIM_N * 0.6, ZONE + 0.5, ZONE + 3, canopyR(s), 10);
      if (!pos) continue;
      trees.push({ pos, s, variant: treeVariant(), rot: r() * Math.PI * 2 });
    }

    // Grazing animals spread around the grass.
    const ANIMAL_N = 10;
    for (let i = 0; i < ANIMAL_N; i++) {
      const baseA = (i / ANIMAL_N) * Math.PI * 2;
      const pos = spread(baseA, (Math.PI * 2) / ANIMAL_N * 1.4, 9, ZONE - 1, 1.5, 10);
      if (!pos) continue;
      animals.push({ pos, s: 0.9 + r() * 0.4, rot: r() * Math.PI * 2, kind: r() < 0.6 ? "sheep" : "cow" });
    }
    // Ground charm — bushes, flower patches and rocks scattered on the grass,
    // kept off roads AND out of houses/trees (via the collision list) so nothing
    // pokes through a wall or trunk.
    const scatter = (n: number, rMin: number, rMax: number, pad: number, cb: (pos: Vec3) => void) => {
      for (let i = 0; i < n; i++) {
        for (let tries = 0; tries < 10; tries++) {
          const a = r() * Math.PI * 2;
          const rad = rMin + r() * (rMax - rMin);
          const x = Math.cos(a) * rad;
          const z = Math.sin(a) * rad;
          if (fits(x, z, pad)) { cb([x, 0, z]); break; }
        }
      }
    };
    scatter(18, 8, ZONE + 1, 0.9, (pos) => bushes.push({ pos, s: 0.8 + r() * 0.7 }));
    scatter(16, 8, ZONE + 1, 0.6, (pos) => flowers.push({ pos, s: 0.8 + r() * 0.6 }));
    scatter(12, 8, ZONE + 2, 0.6, (pos) => rocks.push({ pos, s: 0.6 + r() * 0.8, rot: r() * Math.PI * 2 }));

    // Grass-tone patches so the ground isn't one flat green (padded 0 — harmless under roads).
    const PATCH = ["#6fb873", "#8fd490", "#74c47c", "#b09b6a"];
    const patches: { pos: Vec3; r: number; color: string }[] = [];
    scatter(12, 7, ZONE, 0, (pos) => patches.push({ pos, r: 2.5 + r() * 4, color: PATCH[Math.floor(r() * PATCH.length)] }));

    // Grass tufts — dense little blade clusters that break up the flat lawn.
    // Allowed to sit anywhere on grass (just off the roads), not collision-claimed.
    const GRASS_TONE = ["#5aa85f", "#6fbf6a", "#4f9a54", "#7ac878"];
    const grass: { pos: Vec3; s: number; color: string }[] = [];
    for (let i = 0; i < 46; i++) {
      for (let tries = 0; tries < 8; tries++) {
        const a = r() * Math.PI * 2;
        const rad = 7 + r() * (ZONE - 5);
        const x = Math.cos(a) * rad;
        const z = Math.sin(a) * rad;
        if (!onRoad(x, z, 0.5)) { grass.push({ pos: [x, 0, z], s: 0.7 + r() * 0.8, color: GRASS_TONE[Math.floor(r() * GRASS_TONE.length)] }); break; }
      }
    }

    // Stones lining each dirt path so the trails read as intentional.
    const pathStones: { pos: Vec3; s: number; rot: number }[] = [];
    for (const a of PATH_ANGLES) {
      const ca = Math.cos(a), sa = Math.sin(a);
      // perpendicular unit vector to offset to the path edges
      const px = -sa, pz = ca;
      for (let along = 6; along < 25; along += 2.4 + r() * 1.2) {
        for (const side of [-1, 1]) {
          const off = 1.5 + r() * 0.3;
          const x = ca * along + px * side * off;
          const z = sa * along + pz * side * off;
          if (Math.hypot(x, z) > ZONE + 1) continue;
          pathStones.push({ pos: [x, 0, z], s: 0.35 + r() * 0.35, rot: r() * Math.PI * 2 });
        }
      }
    }

    // Lily pads + reeds for the pond (centred at 12,9 with water radius ~2.6).
    const POND: Vec3 = [12, 0, 9];
    const lilies: { pos: Vec3; flower: boolean }[] = [];
    for (let i = 0; i < 5; i++) {
      const a = r() * Math.PI * 2;
      const rad = r() * 1.9;
      lilies.push({ pos: [POND[0] + Math.cos(a) * rad, 0.06, POND[2] + Math.sin(a) * rad], flower: r() < 0.5 });
    }
    const reeds: { pos: Vec3; s: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const a = r() * Math.PI * 2;
      const rad = 2.7 + r() * 0.5;
      reeds.push({ pos: [POND[0] + Math.cos(a) * rad, 0, POND[2] + Math.sin(a) * rad], s: 0.7 + r() * 0.5 });
    }

    // Cobblestones paving the central plaza — concentric rings of small stones
    // in mixed greys so the town centre reads as laid pavement, not bare dirt.
    const COBBLE = ["#a8a29a", "#948e85", "#b6b0a6", "#877f76"];
    const cobbles: { pos: Vec3; s: number; rot: number; color: string }[] = [];
    for (const [ringR, count] of [[3.4, 20], [4.3, 24], [5.1, 28]] as const) {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + (r() - 0.5) * 0.12;
        const rr = ringR + (r() - 0.5) * 0.4;
        cobbles.push({
          pos: [Math.cos(a) * rr, 0.15, Math.sin(a) * rr],
          s: 0.55 + r() * 0.3,
          rot: r() * Math.PI,
          color: COBBLE[Math.floor(r() * COBBLE.length)],
        });
      }
    }

    // Dirt paths radiating from the plaza to the shore.
    const paths = PATH_ANGLES.map((a) => ({ angle: a, mid: 15.5, len: 21 }));
    return { houses, trees, animals, paths, bushes, flowers, rocks, patches, grass, pathStones, lilies, reeds, cobbles, solids };
  }, []);

  // Publish the solid colliders + interactable buildings (each house = an agent)
  // to a walking-world parent (once).
  useEffect(() => {
    onSolids?.(solids);
  }, [solids, onSolids]);
  useEffect(() => {
    onBuildings?.(houses.map((h, i) => ({ key: `h${i}`, x: h.pos[0], z: h.pos[2] })));
  }, [houses, onBuildings]);

  // Slow turntable in showcase mode; held still while you're walking around.
  useFrame((_, dt) => {
    if (group.current && !walkable) group.current.rotation.y += dt * 0.05;
  });

  return (
    <group ref={group}>
      {/* Grass */}
      <mesh position={[0, -0.75, 0]} receiveShadow>
        <cylinderGeometry args={[ISLAND_RADIUS, ISLAND_RADIUS, 1.5, 64]} />
        <meshStandardMaterial color="#7ec77f" roughness={1} />
      </mesh>
      {/* Grassy bevel — the lawn rounds over the edge instead of a sheer drop.
          Sat a hair BELOW the grass top so its top disc isn't coplanar with it
          (that coincidence was the z-fighting ring). */}
      <mesh position={[0, -0.37, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[ISLAND_RADIUS, ISLAND_RADIUS + 3, 0.7, 64]} />
        <meshStandardMaterial color="#6fb772" roughness={1} />
      </mesh>
      {/* Sandy beach sloping gently down into the sea (top tucked just under the
          bevel's bottom so those discs don't z-fight either). */}
      <mesh position={[0, -1.36, 0]} receiveShadow>
        <cylinderGeometry args={[ISLAND_RADIUS + 3, ISLAND_RADIUS + 6, 1.2, 64]} />
        <meshStandardMaterial color="#e8d6a6" roughness={1} />
      </mesh>
      {/* Rock underside sinking into the sea */}
      <mesh position={[0, -4, 0]}>
        <cylinderGeometry args={[ISLAND_RADIUS + 2, ISLAND_RADIUS - 6, 6, 48]} />
        <meshStandardMaterial color="#7d6f5c" roughness={1} />
      </mesh>

      {/* Grass-tone patches so the ground varies. Each is stacked at a slightly
          different height so overlapping patches don't z-fight, and polygonOffset
          keeps them cleanly above the grass. */}
      {patches.map((p, i) => (
        <mesh key={`gp${i}`} position={[p.pos[0], 0.03 + i * 0.004, p.pos[2]]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <circleGeometry args={[p.r, 24]} />
          <meshStandardMaterial color={p.color} roughness={1} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
        </mesh>
      ))}

      {/* A little pond */}
      <group position={[12, 0, 9]}>
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[2.6, 3.3, 28]} />
          <meshStandardMaterial color="#cbb58a" roughness={1} />
        </mesh>
        <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[2.7, 28]} />
          <meshStandardMaterial color="#5bb8e0" roughness={0.2} metalness={0.25} />
        </mesh>
      </group>
      {lilies.map((l, i) => (
        <LilyPad key={`ly${i}`} position={l.pos} flower={l.flower} />
      ))}
      {reeds.map((rd, i) => (
        <Reed key={`rd${i}`} position={rd.pos} scale={rd.s} />
      ))}

      {/* Dirt paths + central plaza. The boxes are EMBEDDED into the grass (they
          straddle y=0) so no face is coplanar with the lawn — that coincidence was
          the flicker near the middle. */}
      {paths.map((p, i) => (
        <mesh key={`p${i}`} position={[Math.cos(p.angle) * p.mid, 0, Math.sin(p.angle) * p.mid]} rotation={[0, -p.angle, 0]} receiveShadow>
          <boxGeometry args={[p.len, 0.18, 2.4]} />
          <meshStandardMaterial color="#cbb187" roughness={1} />
        </mesh>
      ))}
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <cylinderGeometry args={[5.5, 5.5, 0.22, 32]} />
        <meshStandardMaterial color="#c3b7a2" roughness={1} />
      </mesh>
      {/* Cobblestones paving the plaza */}
      {cobbles.map((c, i) => (
        <mesh key={`cb${i}`} position={c.pos} rotation={[0, c.rot, 0]} receiveShadow>
          <boxGeometry args={[c.s, 0.12, c.s * 0.8]} />
          <meshStandardMaterial color={c.color} roughness={1} />
        </mesh>
      ))}

      {/* Lamp posts lining the paths — offset perpendicular to the path so they
          sit beside it, never on it (alternating sides). */}
      {paths.flatMap((p, i) =>
        [8, 20].map((rad, j) => {
          const px = -Math.sin(p.angle), pz = Math.cos(p.angle); // perpendicular
          const side = j % 2 === 0 ? 1 : -1;
          return (
            <LampPost
              key={`l${i}-${j}`}
              position={[Math.cos(p.angle) * rad + px * side * 2.3, 0, Math.sin(p.angle) * rad + pz * side * 2.3]}
            />
          );
        })
      )}

      <Fountain />

      {/* A dock + boat off the shore, and a windmill on the edge */}
      <Dock position={[ISLAND_RADIUS + 1, -1.3, 0]} rotation={Math.PI / 2} />
      <Boat position={[ISLAND_RADIUS + 7, -1.4, 3]} />
      <Windmill position={[-15, 0, 14]} rotation={-0.6} />
      <BellTower position={[15.5, 0, -12.6]} rotation={0.5} />
      <Well position={[7, 0, 6]} rotation={0.3} />
      <Cart position={[10, 0, -2]} rotation={-0.7} />
      <HayBale position={[-10.5, 0, 17.5]} rotation={0.4} />
      <HayBale position={[-11.8, 0, 16.7]} rotation={-0.5} />
      <HayBale position={[-9.8, 0, 18.4]} rotation={0.9} scale={0.9} />
      <VeggieGarden position={[-3.9, 0, -14.5]} rotation={0.2} />
      <Barn position={[-21, 0, 4]} rotation={Math.atan2(21, -4)} />

      {/* Town life: market stalls, benches, barrels, a gathering + fireflies */}
      <MarketStall position={[7.5, 0, -1]} rotation={-0.4} awning="#e07a5f" />
      <MarketStall position={[-6.5, 0, 4]} rotation={0.9} awning="#4a90c2" />
      <Barrel position={[8.9, 0, -1.7]} rotation={0.3} />
      <Barrel position={[9.3, 0, -0.5]} rotation={-0.5} />
      <Barrel position={[-7.9, 0, 4.4]} rotation={0.8} />
      {/* Benches ringing the plaza, facing the fountain */}
      {[0.6, 2.2, 3.9, 5.4].map((a, i) => {
        const bx = Math.cos(a) * 7;
        const bz = Math.sin(a) * 7;
        return <Bench key={`bn${i}`} position={[bx, 0, bz]} rotation={Math.atan2(-bx, -bz)} />;
      })}
      {[0, 1.3, 2.6, 3.9, 5.2].map((a, i) => (
        <group key={`gv${i}`} position={[Math.cos(a) * 6.5, 0, Math.sin(a) * 6.5]} rotation={[0, -a - Math.PI / 2, 0]}>
          <Villager
            shirt={SHIRT[i % SHIRT.length]}
            hair={HAIR[(i * 3) % HAIR.length]}
            skin={SKIN[(i * 2) % SKIN.length]}
            hat={i % 4 === 0 ? HAT[i % HAT.length] : undefined}
          />
        </group>
      ))}
      <Fireflies />

      {houses.map((b, i) => (
        <House key={`h${i}`} position={b.pos} w={b.w} d={b.d} h={b.h} wall={b.wall} roof={b.roof} rotation={b.rot} chimney={b.chimney} wing={b.wing} porch={b.porch} dormer={b.dormer} />
      ))}
      {trees.map((t, i) => (
        <Tree key={`t${i}`} position={t.pos} scale={t.s} variant={t.variant} rotation={t.rot} />
      ))}
      {bushes.map((b, i) => (
        <Bush key={`bu${i}`} position={b.pos} scale={b.s} />
      ))}
      {flowers.map((f, i) => (
        <Flowers key={`fl${i}`} position={f.pos} scale={f.s} />
      ))}
      {rocks.map((rk, i) => (
        <Rock key={`rk${i}`} position={rk.pos} scale={rk.s} rotation={rk.rot} />
      ))}
      {/* Stones lining the paths */}
      {pathStones.map((s, i) => (
        <Rock key={`ps${i}`} position={s.pos} scale={s.s} rotation={s.rot} />
      ))}
      {/* Grass tufts — skipped on low-power devices to save draw calls */}
      {!lowPower && grass.map((g, i) => (
        <GrassTuft key={`gt${i}`} position={g.pos} scale={g.s} color={g.color} />
      ))}
      {animals.map((a, i) =>
        a.kind === "sheep" ? (
          <Sheep key={`a${i}`} position={a.pos} scale={a.s} rotation={a.rot} />
        ) : (
          <Cow key={`a${i}`} position={a.pos} scale={a.s} rotation={a.rot} />
        )
      )}

      <Villagers />
      <Butterflies />
    </group>
  );
}

// A far-off hazy islet on the horizon — a grassy dome with a beach and a few
// dark tree silhouettes. Sits deep in the fog so it reads as distant land,
// making the sea feel like part of a larger world instead of an empty void.
function DistantIsle({ position, scale = 1, seed }: { position: Vec3; scale?: number; seed: number }) {
  const trees = useMemo(() => {
    const r = rng(seed);
    return Array.from({ length: 5 + Math.floor(r() * 4) }).map(() => ({
      x: (r() - 0.5) * 14,
      z: (r() - 0.5) * 14,
      h: 5 + r() * 5,
      w: 2.5 + r() * 1.5,
    }));
  }, [seed]);
  return (
    <group position={position} scale={scale}>
      {/* Sandy base */}
      <mesh position={[0, -0.5, 0]}>
        <cylinderGeometry args={[13, 15, 1, 24]} />
        <meshStandardMaterial color="#d8c39a" roughness={1} />
      </mesh>
      {/* Grassy hill */}
      <mesh position={[0, 0, 0]}>
        <sphereGeometry args={[11, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2.3]} />
        <meshStandardMaterial color="#6fae66" roughness={1} />
      </mesh>
      {/* Tree silhouettes */}
      {trees.map((t, i) => (
        <mesh key={i} position={[t.x, 3.5, t.z]}>
          <coneGeometry args={[t.w, t.h, 7]} />
          <meshStandardMaterial color="#4f8a52" roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

// Drifting pollen / light motes — tiny warm specks that float and bob over the
// village. Bloom picks them up as soft glows, adding depth and "air".
function Motes({ count = 42 }: { count?: number }) {
  const group = useRef<THREE.Group>(null);
  const seeds = useMemo(() => {
    const r = rng(4242);
    return Array.from({ length: count }).map(() => ({
      x: (r() - 0.5) * 58,
      y: 2 + r() * 15,
      z: (r() - 0.5) * 58,
      speed: 0.1 + r() * 0.22,
      phase: r() * Math.PI * 2,
      amp: 0.6 + r() * 1.8,
      s: 0.04 + r() * 0.08,
    }));
  }, [count]);
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.elapsedTime;
    group.current.children.forEach((c, i) => {
      const p = seeds[i];
      c.position.set(
        p.x + Math.sin(t * p.speed + p.phase) * p.amp,
        p.y + Math.sin(t * p.speed * 0.7 + p.phase) * p.amp * 0.6,
        p.z + Math.cos(t * p.speed + p.phase) * p.amp
      );
    });
  });
  return (
    <group ref={group}>
      {seeds.map((p, i) => (
        <mesh key={i} position={[p.x, p.y, p.z]}>
          <sphereGeometry args={[p.s, 6, 6]} />
          <meshBasicMaterial color="#fff0c8" transparent opacity={0.5} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

// A shallow lagoon hugging the beach — concentric translucent turquoise bands
// that fade from bright clear water at the shore into the deep sea, framing the
// island like a tropical reef.
function Shallows() {
  const bands: { inner: number; outer: number; color: string; opacity: number }[] = [
    { inner: ISLAND_RADIUS + 3, outer: ISLAND_RADIUS + 10, color: "#7fd8dd", opacity: 0.62 },
    { inner: ISLAND_RADIUS + 10, outer: ISLAND_RADIUS + 17, color: "#5cc3d4", opacity: 0.46 },
    { inner: ISLAND_RADIUS + 17, outer: ISLAND_RADIUS + 25, color: "#46a8c6", opacity: 0.28 },
  ];
  return (
    <group>
      {bands.map((b, i) => (
        <mesh key={i} position={[0, WATER_Y + 0.06 + i * 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[b.inner, b.outer, 80]} />
          <meshStandardMaterial
            color={b.color}
            transparent
            opacity={b.opacity}
            roughness={0.2}
            metalness={0.2}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

// A sailboat drifting a slow, wide elliptical loop around the island, riding a
// gentle bob and heeling slightly as it turns.
function SailingBoat() {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const et = state.clock.elapsedTime;
    const t = et * 0.045;
    const rx = 52, rz = 44;
    ref.current.position.set(Math.cos(t) * rx, -1.35 + Math.sin(et * 0.5) * 0.12, Math.sin(t) * rz);
    // Heading is the tangent of the ellipse; heel with the bob.
    ref.current.rotation.set(0, Math.atan2(-Math.cos(t) * rz, Math.sin(t) * rx), Math.sin(et * 0.5) * 0.05);
  });
  return (
    <group ref={ref}>
      <Sailboat />
    </group>
  );
}

// The shared world environment — sky, fog, light, sea, distant land, atmosphere
// and the post-processing stack. Used by both the showcase landing and the
// walkable world so they look identical. The village itself is rendered
// separately by the caller (showcase = turntable, walk = held still + player).
// perfTier: the adaptive quality ladder (0 = full). 1 drops post-processing,
// 2 also drops sun shadows — set by the in-world FPS governor so weak
// machines degrade gracefully instead of chugging at full quality.
export function WorldEnvironment({ lowPower = false, sea = true, shadowExtent = 60, ao = true, shadowFollowRef, perfTier = 0 }: { lowPower?: boolean; sea?: boolean; shadowExtent?: number; ao?: boolean; shadowFollowRef?: React.RefObject<{ x: number; z: number }>; perfTier?: number }) {
  return (
    <>
      {/* Living sky: sun/moon arcs, keyframed light, stars — one 20-min day */}
      <DayNight shadowExtent={shadowExtent} sea={sea} followRef={shadowFollowRef} shadows={perfTier < 2} />
      <Cloud position={[-26, 22, -24]} scale={1.5} />
      <Cloud position={[28, 26, -30]} scale={1.9} />
      <Cloud position={[2, 28, -40]} scale={1.6} />
      {sea && <Ocean />}
      {sea && <Shallows />}
      {sea && <Foam />}
      {/* Distant hazy islands on the horizon (world-space — they don't rotate) */}
      {sea && <DistantIsle position={[150, -2, -70]} scale={1.5} seed={11} />}
      {sea && <DistantIsle position={[-175, -2, -20]} scale={1.9} seed={22} />}
      {sea && <DistantIsle position={[70, -2, -195]} scale={1.3} seed={33} />}
      {!lowPower && <Motes />}
      {sea && <SailingBoat />}
      <Birds />

      {/* Post-processing: AO for depth (skipped on weak GPUs), warm colour grade,
          bloom for the glows, a gentle tilt-shift, anti-aliasing and a soft vignette */}
      {/* multisampling=0: the composer defaults to 8x MSAA render targets — pure
          fill-rate cost we don't need since SMAA is in the chain. This was the
          frame drop when foliage filled the screen. */}
      {perfTier < 1 && (
        <EffectComposer multisampling={0}>
          {[
            !lowPower && ao ? <N8AO key="ao" halfRes aoRadius={2.5} intensity={2.2} distanceFalloff={1.2} color="#20242e" /> : null,
            <HueSaturation key="hs" saturation={0.14} />,
            <BrightnessContrast key="bc" brightness={0.015} contrast={0.09} />,
            <Bloom key="bl" intensity={0.6} luminanceThreshold={0.78} luminanceSmoothing={0.3} mipmapBlur />,
            <SMAA key="aa" />,
            <Vignette key="vg" offset={0.32} darkness={0.5} />,
          ].filter(Boolean) as ReactElement[]}
        </EffectComposer>
      )}
    </>
  );
}

// Demo agents shown if the network snapshot isn't available (or is empty), so
// the landing world never looks abandoned.
const DEMO_PLOTS: OpenPlot[] = (() => {
  const specs: [string, string][] = [
    ["Atlas", "Data"], ["Beacon", "Data"], ["Cinder", "Data"],
    ["Drift", "Vision"], ["Ember", "Vision"], ["Flux", "Vision"], ["Gale", "Vision"],
    ["Haven", "Trading"], ["Iris", "Trading"], ["Juno", "Trading"],
    ["Krait", "Builder"], ["Lumen", "Builder"], ["Mistral", "Builder"], ["Nova", "Builder"],
  ];
  return specs.map(([name, district], i) => ({
    agentId: `demo-${i}`,
    name,
    district,
    x: 0,
    z: 0,
    size: 2 + (i % 4),
    active: i % 3 !== 2,
    walletAddress: null,
  }));
})();

// A slow cinematic drift around the town — low over the rooftops, gently rising
// and falling, always looking through the plaza. This IS the live world.
function CinematicPan() {
  const { camera } = useThree();
  useFrame((state) => {
    const t = state.clock.elapsedTime * 0.042;
    const r = 62 + Math.sin(t * 0.6) * 9;
    camera.position.set(Math.cos(t) * r, 26 + Math.sin(t * 0.45) * 6, Math.sin(t) * r);
    camera.lookAt(0, 2, 0);
  });
  return null;
}

export default function Landing({ onEnter }: { onEnter: () => void }) {
  // Pause rendering when the tab isn't visible — no GPU/battery burn in background.
  const [frameloop, setFrameloop] = useState<"always" | "never">("always");
  useEffect(() => {
    const onVis = () => setFrameloop(document.hidden ? "never" : "always");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Rough low-power heuristic — drop the heaviest effects + pixel ratio on weak GPUs.
  const lowPower = useMemo(
    () => typeof navigator !== "undefined" && (navigator.hardwareConcurrency ?? 8) <= 4,
    []
  );
  // Phones have 3x screens — a 1x canvas there reads blurry. The landing is a
  // slow cinematic pan, so it can afford the pixels.
  const isTouch = useMemo(() => typeof navigator !== "undefined" && navigator.maxTouchPoints > 0, []);


  // The landing shows the REAL world — the same one you walk into. Live agents
  // from the network snapshot; demo plots only as a fallback.
  const [plots, setPlots] = useState<OpenPlot[] | null>(null);
  useEffect(() => {
    let alive = true;
    // A hung connection would leave `plots` null forever and pin the visitor on
    // the boot screen — time the fetch out and fall back to the demo town.
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const fallback = setTimeout(() => { if (alive) setPlots((p) => p ?? DEMO_PLOTS); }, 8500);
    fetch("/api/world", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { plots?: OpenPlot[] } | null) => {
        if (alive) setPlots(d?.plots?.length ? d.plots : DEMO_PLOTS);
      })
      .catch(() => { if (alive) setPlots((p) => p ?? DEMO_PLOTS); });
    return () => { alive = false; clearTimeout(timeout); clearTimeout(fallback); };
  }, []);

  // Cover the raw sky-blue with a branded boot that fades once the town data
  // is in and the first frames have drawn.
  const [bootGone, setBootGone] = useState(false);
  const [bootFading, setBootFading] = useState(false);
  useEffect(() => {
    if (!plots) return;
    const f = setTimeout(() => setBootFading(true), 350);
    const g = setTimeout(() => setBootGone(true), 1150);
    return () => { clearTimeout(f); clearTimeout(g); };
  }, [plots]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#8eccf2]">
      <Canvas
        shadows="soft"
        frameloop={frameloop}
        dpr={[1, isTouch ? Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio : 2) : lowPower ? 1 : 1.5]}
        camera={{ position: [0, 30, 70], fov: 50 }}
      >
        <WorldEnvironment lowPower={lowPower} sea={false} shadowExtent={90} ao={false} perfTier={isTouch ? 2 : 0} />
        {plots && <OpenWorld plots={plots} lowPower={lowPower} showTitle={false} />}
        <CinematicPan />
      </Canvas>

      {!bootGone && (
        <div className={`absolute inset-0 z-40 bg-[#0b0f14] flex flex-col items-center justify-center gap-4 transition-opacity duration-700 ${bootFading ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
          <p className="text-teal-400 font-mono tracking-[0.4em] text-sm">AXON WORLD</p>
          <div className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="w-2 h-2 rounded-full bg-teal-400 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </div>
        </div>
      )}

      {/* Title overlay */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6 pointer-events-none">
        <p className="text-sm tracking-[0.4em] text-white/80 font-mono mb-3 drop-shadow">AXON · PHASE 10</p>
        <h1 className="text-6xl sm:text-8xl font-black text-white drop-shadow-[0_4px_20px_rgba(0,0,0,0.35)] mb-4">
          AXON WORLD
        </h1>
        <p className="text-white/90 text-lg max-w-md mb-10 drop-shadow">
          This is the live Axon network — every house is a real agent.
          Walk in and explore.
        </p>
        <button
          onClick={onEnter}
          className="pointer-events-auto px-10 py-4 rounded-full bg-white text-gray-900 text-lg font-bold shadow-xl hover:scale-105 active:scale-100 transition-transform"
        >
          Enter ▸
        </button>
      </div>
    </div>
  );
}
