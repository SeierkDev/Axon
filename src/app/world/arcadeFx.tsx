"use client";

// Arcade particle FX — the juice layer, powered by three.quarks.
//
// One BatchedRenderer batches every live effect into a handful of draw calls
// (that's the whole reason quarks was picked — juice that respects the FPS
// budget we fought for). Game code never touches particle systems directly:
// it calls the tiny `arcadeFx.*` API below (same pattern as worldSfx), events
// queue up, and the <ArcadeFxLayer/> inside the Canvas drains the queue each
// frame, spawning short one-shot bursts that dispose themselves.

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  BatchedRenderer,
  ParticleSystem,
  ConstantValue,
  IntervalValue,
  ConstantColor,
  Gradient,
  ColorOverLife,
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
  ApplyForce,
  SphereEmitter,
  RenderMode,
  Vector3 as QVec3,
  Vector4 as QVec4,
} from "three.quarks";

type FxEvent =
  | { kind: "muzzle"; x: number; y: number; z: number }
  | { kind: "zombieHit"; x: number; y: number; z: number }
  | { kind: "zombieDie"; x: number; y: number; z: number; boss: boolean }
  | { kind: "confetti"; x: number; y: number; z: number }
  | { kind: "land"; x: number; y: number; z: number; hard: boolean }
  | { kind: "checkpoint"; x: number; y: number; z: number }
  | { kind: "splash"; x: number; y: number; z: number }
  | { kind: "explode"; x: number; y: number; z: number }
  | { kind: "crumble"; x: number; y: number; z: number; size: number }
  | { kind: "tracer"; x: number; y: number; z: number; x2: number; y2: number; z2: number };

const queue: FxEvent[] = [];

// ── Camera trauma shake ───────────────────────────────────────────────────────
// The classic trauma model: events ADD trauma, the camera offset is trauma²
// (small hits barely register, big ones slam), and it decays fast. The Player
// controller applies it as the LAST step of its camera pose — additive, so it
// composes with first-person, third-person and the sniper zoom alike. Nothing
// outside the arcade ever adds trauma, so the walkable world is untouched.
export const arcadeShake = {
  trauma: 0,
  /** Add shake energy (0..~0.5 per event); clamped so stacked events can't flip the camera. */
  add(amount: number) {
    this.trauma = Math.min(1.2, this.trauma + amount);
  },
};

/** Apply (and decay) the shake — call once per frame AFTER the camera pose is final. */
export function applyCameraShake(camera: THREE.Camera, dt: number) {
  const s = arcadeShake;
  if (s.trauma <= 0.001) {
    s.trauma = 0;
    return;
  }
  const k = s.trauma * s.trauma;
  const t = performance.now() / 1000;
  // cheap smooth noise: pairs of incommensurate sines per axis
  const nx = (Math.sin(t * 47.3) + Math.sin(t * 31.7 + 1.3)) * 0.5;
  const ny = (Math.sin(t * 41.1 + 2.1) + Math.sin(t * 29.3 + 0.7)) * 0.5;
  const nr = (Math.sin(t * 37.9 + 4.2) + Math.sin(t * 26.1 + 2.9)) * 0.5;
  camera.position.x += nx * 0.11 * k;
  camera.position.y += ny * 0.085 * k;
  camera.rotation.z += nr * 0.014 * k;
  s.trauma = Math.max(0, s.trauma - dt * 2.6);
}

// The public API — callable from anywhere (managers inside the Canvas, React
// callbacks outside it). Pushing is free; nothing renders until the layer is
// mounted, so calls are safe no-ops outside an arcade run.
export const arcadeFx = {
  muzzle(x: number, y: number, z: number) {
    queue.push({ kind: "muzzle", x, y, z });
  },
  zombieHit(x: number, y: number, z: number) {
    queue.push({ kind: "zombieHit", x, y, z });
  },
  zombieDie(x: number, y: number, z: number, boss: boolean) {
    queue.push({ kind: "zombieDie", x, y, z, boss });
  },
  confetti(x: number, y: number, z: number) {
    queue.push({ kind: "confetti", x, y, z });
  },
  land(x: number, y: number, z: number, hard = false) {
    queue.push({ kind: "land", x, y, z, hard });
  },
  checkpoint(x: number, y: number, z: number) {
    queue.push({ kind: "checkpoint", x, y, z });
  },
  splash(x: number, y: number, z: number) {
    queue.push({ kind: "splash", x, y, z });
  },
  explode(x: number, y: number, z: number) {
    queue.push({ kind: "explode", x, y, z });
  },
  crumble(x: number, y: number, z: number, size = 1.4) {
    queue.push({ kind: "crumble", x, y, z, size });
  },
  /** A brief hot streak along a shot ray (rifles + sniper) — bloom turns it into light. */
  tracer(x: number, y: number, z: number, x2: number, y2: number, z2: number) {
    queue.push({ kind: "tracer", x, y, z, x2, y2, z2 });
  },
};

// Soft radial dot — every burst particle; drawn once, shared by all systems.
function makeDotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Crisp square — confetti flecks.
function makeSquareTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(2, 2, 12, 12);
  return new THREE.CanvasTexture(c);
}

const shrink = () => new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.9, 0.55, 0), 0]]));
const fade = (r: number, g: number, b: number) =>
  new ColorOverLife(
    new Gradient(
      [[new QVec3(r, g, b), 0], [new QVec3(r, g, b), 1]],
      [[1, 0], [0, 1]], // alpha 1 → 0 across the particle's life
    ),
  );
const gravity = (m: number) => new ApplyForce(new QVec3(0, -1, 0), new ConstantValue(m));

export function ArcadeFxLayer() {
  const { scene } = useThree();
  const batch = useRef<BatchedRenderer | null>(null);
  const mats = useRef<{ add: THREE.Material; dot: THREE.Material; square: THREE.Material } | null>(null);
  const live = useRef<{ sys: ParticleSystem; until: number }[]>([]);

  useEffect(() => {
    const br = new BatchedRenderer();
    scene.add(br);
    batch.current = br;
    const dotTex = makeDotTexture();
    const squareTex = makeSquareTexture();
    mats.current = {
      add: new THREE.MeshBasicMaterial({ map: dotTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      dot: new THREE.MeshBasicMaterial({ map: dotTex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      square: new THREE.MeshBasicMaterial({ map: squareTex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    };
    const liveArr = live.current;
    return () => {
      for (const l of liveArr) {
        br.deleteSystem(l.sys);
        l.sys.emitter.removeFromParent();
      }
      liveArr.length = 0;
      scene.remove(br);
      queue.length = 0;
      for (const m of Object.values(mats.current ?? {})) m.dispose();
      dotTex.dispose();
      squareTex.dispose();
      batch.current = null;
    };
  }, [scene]);

  useFrame((state, delta) => {
    const br = batch.current;
    const m = mats.current;
    if (!br || !m) return;
    const now = state.clock.elapsedTime;

    // One-shot burst factory: emits `count` particles instantly, self-disposes.
    const burst = (opts: {
      x: number; y: number; z: number;
      count: number;
      material: THREE.Material;
      color: [number, number, number];
      life: [number, number];
      speed: [number, number];
      size: number;
      radius: number;
      grav?: number;
    }) => {
      const maxLife = opts.life[1];
      const sys = new ParticleSystem({
        duration: 0.05,
        looping: false,
        startLife: new IntervalValue(opts.life[0], opts.life[1]),
        startSpeed: new IntervalValue(opts.speed[0], opts.speed[1]),
        startSize: new ConstantValue(opts.size),
        startColor: new ConstantColor(new QVec4(opts.color[0], opts.color[1], opts.color[2], 1)),
        worldSpace: true,
        emissionOverTime: new ConstantValue(0),
        emissionBursts: [{ time: 0, count: new ConstantValue(opts.count), cycle: 1, interval: 0.01, probability: 1 }],
        shape: new SphereEmitter({ radius: opts.radius, thickness: 1 }),
        material: opts.material,
        renderMode: RenderMode.BillBoard,
      });
      sys.addBehavior(shrink());
      sys.addBehavior(fade(opts.color[0], opts.color[1], opts.color[2]));
      if (opts.grav) sys.addBehavior(gravity(opts.grav));
      sys.emitter.position.set(opts.x, opts.y, opts.z);
      scene.add(sys.emitter);
      br.addSystem(sys);
      live.current.push({ sys, until: now + maxLife + 0.4 });
    };

    while (queue.length > 0) {
      const e = queue.shift()!;
      // muzzle flashes + tracers are the spammy ones (automatics) — shed them first under load
      if (live.current.length > 40 && (e.kind === "muzzle" || e.kind === "tracer")) continue;
      switch (e.kind) {
        case "muzzle":
          burst({ x: e.x, y: e.y, z: e.z, count: 6, material: m.add, color: [1, 0.83, 0.42], life: [0.06, 0.16], speed: [1.5, 4], size: 0.22, radius: 0.05 });
          break;
        case "tracer": {
          // three hot pinches along the ray — reads as one streak for a frame or two
          for (const f of [0.22, 0.55, 0.85]) {
            burst({
              x: e.x + (e.x2 - e.x) * f,
              y: e.y + (e.y2 - e.y) * f,
              z: e.z + (e.z2 - e.z) * f,
              count: 2, material: m.add, color: [1, 0.78, 0.5],
              life: [0.05, 0.12], speed: [0, 0.4], size: 0.16, radius: 0.06,
            });
          }
          break;
        }
        case "zombieHit":
          burst({ x: e.x, y: e.y, z: e.z, count: 10, material: m.dot, color: [0.42, 0.09, 0.07], life: [0.25, 0.45], speed: [2, 4.5], size: 0.14, radius: 0.22, grav: 9.8 });
          break;
        case "zombieDie":
          burst({ x: e.x, y: e.y, z: e.z, count: e.boss ? 30 : 18, material: m.dot, color: [0.44, 0.52, 0.37], life: [0.5, 0.9], speed: [1, 3], size: e.boss ? 0.4 : 0.28, radius: e.boss ? 0.8 : 0.5, grav: 3 });
          break;
        case "confetti":
          // three tone bursts — teal, gold, coral — one celebratory blast
          burst({ x: e.x, y: e.y, z: e.z, count: 24, material: m.square, color: [0.08, 0.72, 0.65], life: [1.0, 1.7], speed: [5, 9], size: 0.13, radius: 0.15, grav: 9.8 });
          burst({ x: e.x, y: e.y, z: e.z, count: 24, material: m.square, color: [1, 0.84, 0.42], life: [1.0, 1.7], speed: [5, 9], size: 0.13, radius: 0.15, grav: 9.8 });
          burst({ x: e.x, y: e.y, z: e.z, count: 24, material: m.square, color: [0.88, 0.48, 0.37], life: [1.0, 1.7], speed: [5, 9], size: 0.13, radius: 0.15, grav: 9.8 });
          break;
        case "land":
          // dust kicked up at the feet — bigger for a hard landing
          burst({ x: e.x, y: e.y, z: e.z, count: e.hard ? 14 : 8, material: m.dot, color: [0.76, 0.7, 0.56], life: [0.3, 0.6], speed: [1, e.hard ? 3.5 : 2], size: e.hard ? 0.3 : 0.2, radius: 0.35 });
          break;
        case "checkpoint":
          // a teal ring-burst at the flag — the "it counted" moment
          burst({ x: e.x, y: e.y, z: e.z, count: 16, material: m.add, color: [0.31, 0.84, 0.78], life: [0.35, 0.7], speed: [2.5, 5], size: 0.2, radius: 0.2 });
          break;
        case "splash":
          // water thrown up where you went in
          burst({ x: e.x, y: e.y, z: e.z, count: 16, material: m.dot, color: [0.55, 0.78, 0.88], life: [0.35, 0.65], speed: [2.5, 5.5], size: 0.18, radius: 0.3, grav: 9.8 });
          break;
        case "explode":
          // the exploder's payoff: hot core flash + sickly green cloud + debris
          burst({ x: e.x, y: e.y, z: e.z, count: 14, material: m.add, color: [1, 0.7, 0.3], life: [0.12, 0.3], speed: [4, 9], size: 0.5, radius: 0.3 });
          burst({ x: e.x, y: e.y, z: e.z, count: 22, material: m.dot, color: [0.42, 0.55, 0.3], life: [0.5, 1.0], speed: [2, 6], size: 0.4, radius: 0.6, grav: 3 });
          burst({ x: e.x, y: e.y + 0.3, z: e.z, count: 10, material: m.dot, color: [0.3, 0.28, 0.24], life: [0.4, 0.8], speed: [3, 7], size: 0.16, radius: 0.4, grav: 9.8 });
          break;
        case "crumble":
          // the ledge lets go — stone chips and dust pouring downward
          burst({ x: e.x, y: e.y, z: e.z, count: 18, material: m.dot, color: [0.62, 0.58, 0.5], life: [0.4, 0.9], speed: [1.5, 4], size: 0.22, radius: e.size, grav: 9.8 });
          break;
      }
    }

    // retire finished one-shots
    for (let i = live.current.length - 1; i >= 0; i--) {
      if (now > live.current[i].until) {
        const l = live.current[i];
        br.deleteSystem(l.sys);
        l.sys.emitter.removeFromParent();
        live.current.splice(i, 1);
      }
    }

    br.update(delta);
  });

  return null;
}
