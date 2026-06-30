"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { WorldEnvironment, type Collider, type WorldBuilding } from "./Landing";
import { OpenWorld, type OpenDistrict, type FishSpot, type BenchSpot, type GatherSpot, type WorldLandmarks } from "./OpenWorld";
import { connectPhantom, disconnectPhantom, getPhantom } from "./wallet";
import { usePresence, EMOTE_GLYPH, type PeerMeta, type PeerPose, type Bubble } from "./presence";
import { WorldMusic, worldSfx } from "./audio";
import { ITEMS, RARITY_COLOR, RARITY_LABEL, RARITY_ORDER, rollCatch, rollGift, type ItemDef, type Rarity } from "./items";
import { ItemIcon } from "./ItemIcon";

// Darken a #rrggbb hex by factor f (0..1).
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * f), g = Math.round(((n >> 8) & 0xff) * f), b = Math.round((n & 0xff) * f);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export type HairStyle = "none" | "short" | "ponytail" | "bun" | "spiky";
export type HatStyle = "none" | "cowboy" | "cap" | "beanie" | "bucket";
export const HAIR_STYLES: HairStyle[] = ["none", "short", "ponytail", "bun", "spiky"];
export const HAT_STYLES: HatStyle[] = ["none", "cowboy", "cap", "beanie", "bucket"];

export interface AvatarLook {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  hat: string;
  hatStyle: HatStyle;
  shirt: string;
  pants: string;
  /** Earned wearable — visible progression from the minigames. */
  flair?: "none" | "crown" | "rod";
}

// The fixed guest character — a friendly blocky look (brown hair, teal shirt).
const DEFAULT_LOOK: AvatarLook = {
  skin: "#e8c0a0",
  hair: "#4a3419",
  hairStyle: "short",
  hat: "#7c4a2a",
  hatStyle: "none",
  shirt: "#86d0cf",
  pants: "#6f8aa8",
};

// Phase 10 (10.2 + 10.3): walking the world + agent interaction. "Enter" drops
// you into the village island you see on the landing page, steered in third
// person (WASD/arrows, drag to look). Every house maps to a real registered
// agent: walk up to one and it beacons + highlights; press E (or tap the prompt)
// to open a card with that agent's live data (reputation, tasks, USDC earned,
// verification, activity).

const PLAYER_RADIUS = 0.7;
const WALK_SPEED = 9;
const RUN_SPEED = 16;
const CAM_DIST = 11;
const CAM_HEIGHT = 6.5;
const INTERACT_RANGE = 7;
const GRAVITY = 20;
const JUMP_V = 7.5;

type Gait = { speed: number; mode?: "sit" | "fish" | "wave" | "deny" | null };

// Ignore game keys while the player is typing in a chat/text field.
function isTyping(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

// A cute chibi character: big friendly head with a face, rounded body, hands and
// shoes. Fully animated — a walk/run cycle (limb swing + torso bob), gentle idle
// breathing + arm sway, and a forward lean when sprinting.
// Blocky hair built from boxes, per style. Head cube is 0.8 wide, centred at
// local [0, 0.4, 0]; forward is +Z.
// Each style has its own silhouette — and when `under` is true (a hat is worn)
// the hair swaps to a hat-safe version: a WRAP BAND right at the hat line (so
// no skin ever shows between fringe and brim — the "bald spot" fix), longer
// sides, and low tails only. Nothing can poke through the hat.
function BlockHair({ style, color, under = false }: { style: HairStyle; color: string; under?: boolean }) {
  if (style === "none") return null;
  const mat = <meshStandardMaterial color={color} roughness={0.95} />;
  const dark = <meshStandardMaterial color={shade(color, 0.78)} roughness={0.95} />;
  const tie = <meshStandardMaterial color="#c94f6d" roughness={0.7} />;
  const fringe = (
    <>
      <mesh position={[0, 0.64, 0.42]}>
        <boxGeometry args={[0.86, 0.13, 0.06]} />
        {mat}
      </mesh>
      {[-0.26, 0.01, 0.27].map((x, i) => (
        <mesh key={`fr${i}`} position={[x, 0.56 - (i % 2) * 0.02, 0.42]}>
          <boxGeometry args={[0.24, 0.1, 0.05]} />
          {i % 2 ? dark : mat}
        </mesh>
      ))}
    </>
  );
  const sideburns = [-0.42, 0.42].map((x, i) => (
    <mesh key={`sb${i}`} position={[x, 0.24, 0.28]}>
      <boxGeometry args={[0.06, 0.16, 0.14]} />
      {dark}
    </mesh>
  ));

  if (under) {
    return (
      <group>
        {/* Wrap band at the hat line — covers the whole head edge under the brim */}
        <mesh position={[0, 0.72, -0.01]}>
          <boxGeometry args={[0.88, 0.22, 0.92]} />
          {mat}
        </mesh>
        {/* Full-height sides + back reaching up to the band */}
        {[-0.45, 0.45].map((x, i) => (
          <mesh key={i} position={[x, 0.46, -0.04]}>
            <boxGeometry args={[0.07, style === "ponytail" ? 0.62 : 0.44, 0.88]} />
            {mat}
          </mesh>
        ))}
        <mesh position={[0, 0.46, -0.44]}>
          <boxGeometry args={[0.86, 0.5, 0.08]} />
          {mat}
        </mesh>
        {fringe}
        {sideburns}
        {/* Low tails that clear any brim */}
        {style === "ponytail" && (
          <group position={[0, 0.42, -0.52]} rotation={[0.32, 0, 0]}>
            <mesh position={[0, 0.08, 0]}>
              <boxGeometry args={[0.24, 0.08, 0.22]} />
              {tie}
            </mesh>
            <mesh castShadow>
              <boxGeometry args={[0.2, 0.32, 0.18]} />
              {mat}
            </mesh>
            <mesh position={[0, -0.3, 0.08]} castShadow>
              <boxGeometry args={[0.16, 0.32, 0.15]} />
              {mat}
            </mesh>
            <mesh position={[0, -0.56, 0.16]}>
              <boxGeometry args={[0.11, 0.22, 0.11]} />
              {dark}
            </mesh>
          </group>
        )}
        {style === "bun" && (
          <group position={[0, 0.4, -0.52]}>
            <mesh castShadow>
              <boxGeometry args={[0.3, 0.26, 0.24]} />
              {mat}
            </mesh>
            <mesh position={[0, 0.16, 0]}>
              <boxGeometry args={[0.2, 0.07, 0.18]} />
              {tie}
            </mesh>
          </group>
        )}
      </group>
    );
  }

  if (style === "short") {
    // Neat, rounded crop: layered cap + step.
    return (
      <group>
        <mesh position={[0, 0.84, -0.02]} castShadow>
          <boxGeometry args={[0.88, 0.24, 0.92]} />
          {mat}
        </mesh>
        <mesh position={[0, 0.96, -0.08]} castShadow>
          <boxGeometry args={[0.72, 0.12, 0.72]} />
          {dark}
        </mesh>
        {[-0.45, 0.45].map((x, i) => (
          <mesh key={i} position={[x, 0.52, -0.04]}>
            <boxGeometry args={[0.07, 0.46, 0.88]} />
            {mat}
          </mesh>
        ))}
        <mesh position={[0, 0.5, -0.44]}>
          <boxGeometry args={[0.86, 0.58, 0.08]} />
          {mat}
        </mesh>
        {fringe}
        {sideburns}
      </group>
    );
  }

  if (style === "ponytail") {
    // Swept-back top, long side curtains, and a high segmented tail.
    return (
      <group>
        <mesh position={[0, 0.86, -0.06]} castShadow>
          <boxGeometry args={[0.88, 0.22, 0.84]} />
          {mat}
        </mesh>
        {/* Swept slope toward the tail */}
        <mesh position={[0, 0.92, -0.32]} rotation={[0.5, 0, 0]} castShadow>
          <boxGeometry args={[0.8, 0.12, 0.42]} />
          {dark}
        </mesh>
        {/* Long side curtains down past the jaw */}
        {[-0.45, 0.45].map((x, i) => (
          <mesh key={i} position={[x, 0.4, -0.06]}>
            <boxGeometry args={[0.07, 0.72, 0.84]} />
            {mat}
          </mesh>
        ))}
        <mesh position={[0, 0.38, -0.44]}>
          <boxGeometry args={[0.86, 0.8, 0.08]} />
          {mat}
        </mesh>
        {fringe}
        {/* High tail: tie + three tapering segments swinging out */}
        <group position={[0, 0.86, -0.5]} rotation={[0.42, 0, 0]}>
          <mesh position={[0, 0.06, 0]}>
            <boxGeometry args={[0.28, 0.1, 0.26]} />
            {tie}
          </mesh>
          <mesh position={[0, -0.12, 0.02]} castShadow>
            <boxGeometry args={[0.24, 0.34, 0.22]} />
            {mat}
          </mesh>
          <mesh position={[0, -0.44, 0.12]} castShadow>
            <boxGeometry args={[0.19, 0.36, 0.17]} />
            {mat}
          </mesh>
          <mesh position={[0, -0.74, 0.24]}>
            <boxGeometry args={[0.13, 0.28, 0.12]} />
            {dark}
          </mesh>
        </group>
      </group>
    );
  }

  if (style === "bun") {
    // Sleek, flat-combed top with a centre part and a proper stacked bun.
    return (
      <group>
        <mesh position={[0, 0.82, -0.02]} castShadow>
          <boxGeometry args={[0.86, 0.16, 0.9]} />
          {mat}
        </mesh>
        {/* Centre-part groove + shine strip */}
        <mesh position={[0, 0.91, 0.06]}>
          <boxGeometry args={[0.05, 0.02, 0.7]} />
          {dark}
        </mesh>
        <mesh position={[0.18, 0.9, 0]} rotation={[0, 0, -0.06]}>
          <boxGeometry args={[0.16, 0.02, 0.78]} />
          <meshStandardMaterial color={shade(color, 1)} roughness={0.6} />
        </mesh>
        {[-0.44, 0.44].map((x, i) => (
          <mesh key={i} position={[x, 0.5, -0.04]}>
            <boxGeometry args={[0.06, 0.42, 0.86]} />
            {mat}
          </mesh>
        ))}
        <mesh position={[0, 0.48, -0.43]}>
          <boxGeometry args={[0.84, 0.56, 0.07]} />
          {mat}
        </mesh>
        {fringe}
        {sideburns}
        {/* The bun: tie + two stacked knots */}
        <group position={[0, 1.0, -0.24]}>
          <mesh position={[0, -0.06, 0]}>
            <boxGeometry args={[0.3, 0.08, 0.3]} />
            {tie}
          </mesh>
          <mesh position={[0, 0.1, 0]} castShadow>
            <boxGeometry args={[0.36, 0.26, 0.36]} />
            {mat}
          </mesh>
          <mesh position={[0, 0.3, 0]} castShadow>
            <boxGeometry args={[0.22, 0.16, 0.22]} />
            {dark}
          </mesh>
        </group>
      </group>
    );
  }

  // Spiky — an undercut: short dark sides, thin base, big two-tone spikes.
  return (
    <group>
      <mesh position={[0, 0.86, -0.02]} castShadow>
        <boxGeometry args={[0.86, 0.18, 0.9]} />
        {mat}
      </mesh>
      {[-0.44, 0.44].map((x, i) => (
        <mesh key={i} position={[x, 0.6, -0.04]}>
          <boxGeometry args={[0.06, 0.28, 0.86]} />
          {dark}
        </mesh>
      ))}
      <mesh position={[0, 0.58, -0.43]}>
        <boxGeometry args={[0.84, 0.34, 0.07]} />
        {dark}
      </mesh>
      {fringe}
      {[
        [-0.26, -0.18, 0.34], [0, -0.2, 0.42], [0.26, -0.18, 0.34],
        [-0.24, 0.12, 0.38], [0.02, 0.16, 0.46], [0.25, 0.12, 0.38],
      ].map(([x, z, h], i) => (
        <mesh key={`sp${i}`} position={[x, 0.96 + h / 2, z]} rotation={[z > 0 ? -0.18 : 0.24, 0, ((i % 3) - 1) * 0.2]} castShadow>
          <coneGeometry args={[0.13, h + 0.16, 4]} />
          {i % 2 ? dark : mat}
        </mesh>
      ))}
    </group>
  );
}

// Blocky hats, per style, in the chosen colour. Crowns are sized to fully
// cover the (cropped) under-hat hair, so nothing ever clips through.
function BlockHat({ style, color }: { style: HatStyle; color: string }) {
  if (style === "none") return null;
  const mat = <meshStandardMaterial color={color} roughness={0.8} />;
  const dark = <meshStandardMaterial color={shade(color, 0.72)} roughness={0.8} />;
  if (style === "cowboy") {
    return (
      <group position={[0, 0.84, 0]}>
        {/* Brim: flat centre + upturned sides */}
        <mesh castShadow>
          <boxGeometry args={[1.06, 0.09, 1.24]} />
          {mat}
        </mesh>
        {[-0.62, 0.62].map((x, i) => (
          <mesh key={i} position={[x, 0.09, 0]} rotation={[0, 0, x > 0 ? 0.42 : -0.42]} castShadow>
            <boxGeometry args={[0.34, 0.08, 1.24]} />
            {mat}
          </mesh>
        ))}
        {/* Crown with a pinched top + band */}
        <mesh position={[0, 0.26, 0]} castShadow>
          <boxGeometry args={[0.74, 0.42, 0.7]} />
          {mat}
        </mesh>
        <mesh position={[0, 0.5, 0]} castShadow>
          <boxGeometry args={[0.54, 0.12, 0.52]} />
          {dark}
        </mesh>
        <mesh position={[0, 0.12, 0]}>
          <boxGeometry args={[0.78, 0.1, 0.74]} />
          {dark}
        </mesh>
      </group>
    );
  }
  if (style === "cap") {
    return (
      <group position={[0, 0.84, 0]}>
        {/* Domed crown: base + rounded step + button */}
        <mesh position={[0, 0.13, 0]} castShadow>
          <boxGeometry args={[0.96, 0.3, 0.96]} />
          {mat}
        </mesh>
        <mesh position={[0, 0.32, 0]} castShadow>
          <boxGeometry args={[0.78, 0.14, 0.78]} />
          {mat}
        </mesh>
        <mesh position={[0, 0.42, 0]}>
          <boxGeometry args={[0.14, 0.06, 0.14]} />
          {dark}
        </mesh>
        {/* Curved-ish brim: main + tip */}
        <mesh position={[0, 0.03, 0.64]} castShadow>
          <boxGeometry args={[0.74, 0.07, 0.4]} />
          {mat}
        </mesh>
        <mesh position={[0, 0.0, 0.86]} rotation={[0.22, 0, 0]}>
          <boxGeometry args={[0.64, 0.06, 0.18]} />
          {dark}
        </mesh>
        {/* Front panel seam */}
        <mesh position={[0, 0.16, 0.485]}>
          <boxGeometry args={[0.5, 0.2, 0.02]} />
          {dark}
        </mesh>
      </group>
    );
  }
  if (style === "beanie") {
    return (
      <group position={[0, 0.8, 0]}>
        {/* Folded band + ribbed body + pompom */}
        <mesh position={[0, 0.04, 0]} castShadow>
          <boxGeometry args={[1.0, 0.2, 1.0]} />
          {dark}
        </mesh>
        <mesh position={[0, 0.24, 0]} castShadow>
          <boxGeometry args={[0.92, 0.24, 0.92]} />
          {mat}
        </mesh>
        <mesh position={[0, 0.42, 0]} castShadow>
          <boxGeometry args={[0.7, 0.18, 0.7]} />
          {mat}
        </mesh>
        <mesh position={[0, 0.58, 0]} castShadow>
          <sphereGeometry args={[0.14, 8, 8]} />
          <meshStandardMaterial color="#f2ede2" roughness={0.95} />
        </mesh>
      </group>
    );
  }
  // bucket
  return (
    <group position={[0, 0.82, 0]}>
      <mesh position={[0, 0.22, 0]} castShadow>
        <boxGeometry args={[0.9, 0.36, 0.9]} />
        {mat}
      </mesh>
      <mesh position={[0, 0.42, 0]}>
        <boxGeometry args={[0.94, 0.06, 0.94]} />
        {dark}
      </mesh>
      {/* Sloped brim: wide lip + lower edge */}
      <mesh position={[0, 0.04, 0]} castShadow>
        <boxGeometry args={[1.18, 0.1, 1.18]} />
        {mat}
      </mesh>
      <mesh position={[0, -0.04, 0]}>
        <boxGeometry args={[1.26, 0.06, 1.26]} />
        {dark}
      </mesh>
    </group>
  );
}

// A blocky, Minecraft-style character with a cube head + face, box body/arms/
// legs, chosen hair style, outfit and body type. Animated: a walk/run cycle
// (limb swing + torso bob), idle arm sway, and a forward lean when sprinting.
function Avatar({ look, gait, hidden }: { look: AvatarLook; gait: React.RefObject<Gait>; hidden: boolean }) {
  const body = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const eyes = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const phase = useRef(0);
  const clock = useRef(0);
  const idleFor = useRef(0);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    clock.current += dt;
    const mode = gait.current?.mode;
    if (mode === "sit") {
      // Park-bench pose: hips ON the seat (not through it), thighs forward.
      if (legL.current) legL.current.rotation.x = -1.5;
      if (legR.current) legR.current.rotation.x = -1.5;
      if (armL.current) armL.current.rotation.x = -0.3;
      if (armR.current) armR.current.rotation.x = -0.3;
      if (torso.current) torso.current.position.y = 0.8;
      if (body.current) { body.current.rotation.x = 0; body.current.position.y = -0.07; }
      if (head.current) head.current.rotation.y = Math.sin(clock.current * 0.5) * 0.12;
      if (eyes.current) eyes.current.scale.y = clock.current % 3.7 < 0.13 ? 0.12 : 1;
      return;
    }
    if (mode === "fish") {
      // Rod-holding stance: both arms out front, a patient little sway.
      if (legL.current) legL.current.rotation.x = 0;
      if (legR.current) legR.current.rotation.x = 0;
      if (armL.current) armL.current.rotation.x = -0.85 + Math.sin(clock.current * 1.1) * 0.04;
      if (armR.current) armR.current.rotation.x = -1.15 + Math.sin(clock.current * 1.1) * 0.04;
      if (torso.current) torso.current.position.y = 0.8;
      if (body.current) { body.current.rotation.x = 0.06; body.current.position.y = 0; }
      if (head.current) head.current.rotation.y = 0;
      if (eyes.current) eyes.current.scale.y = clock.current % 3.7 < 0.13 ? 0.12 : 1;
      return;
    }
    if (mode === "wave") {
      // Doorstep greeting: right arm high with a cheery side-to-side wave and a
      // happy little bounce.
      if (legL.current) legL.current.rotation.x = 0;
      if (legR.current) legR.current.rotation.x = 0;
      if (armL.current) { armL.current.rotation.x = 0.1; armL.current.rotation.z = 0; }
      if (armR.current) {
        armR.current.rotation.x = -2.6;
        armR.current.rotation.z = -0.25 + Math.sin(clock.current * 8) * 0.4;
      }
      if (torso.current) torso.current.position.y = 0.8;
      if (body.current) { body.current.rotation.x = 0; body.current.position.y = Math.abs(Math.sin(clock.current * 6)) * 0.05; }
      if (head.current) { head.current.rotation.y = 0; head.current.rotation.z = Math.sin(clock.current * 3) * 0.06; }
      if (eyes.current) eyes.current.scale.y = clock.current % 3.7 < 0.13 ? 0.12 : 1;
      return;
    }
    if (mode === "deny") {
      // "Sorry, mid-job": arms spread in a small shrug, head shaking no.
      if (legL.current) legL.current.rotation.x = 0;
      if (legR.current) legR.current.rotation.x = 0;
      if (armL.current) { armL.current.rotation.x = -0.55; armL.current.rotation.z = 0.5; }
      if (armR.current) { armR.current.rotation.x = -0.55; armR.current.rotation.z = -0.5; }
      if (torso.current) torso.current.position.y = 0.8;
      if (body.current) { body.current.rotation.x = 0.03; body.current.position.y = 0; }
      if (head.current) { head.current.rotation.y = Math.sin(clock.current * 5) * 0.35; head.current.rotation.z = 0; }
      if (eyes.current) eyes.current.scale.y = clock.current % 3.7 < 0.13 ? 0.12 : 1;
      return;
    }
    if (body.current) body.current.position.y = 0;
    const sp = gait.current?.speed ?? 0;
    const moving = sp > 0.01;
    idleFor.current = moving ? 0 : idleFor.current + dt;
    if (moving) phase.current += dt * (6 + sp * 3.5);
    const amp = Math.min(0.9, 0.25 + sp * 0.45);
    const swing = moving ? Math.sin(phase.current) * amp : 0;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;
    if (armR.current) armR.current.rotation.z = 0;
    if (head.current) head.current.rotation.z = 0;
    if (moving) {
      if (armL.current) armL.current.rotation.x = -swing * 0.85;
      if (armR.current) armR.current.rotation.x = swing * 0.85;
    } else {
      const sway = Math.sin(clock.current * 1.6) * 0.06;
      if (armL.current) armL.current.rotation.x = sway;
      if (armR.current) armR.current.rotation.x = -sway;
    }
    if (torso.current) torso.current.position.y = 0.8 + (moving ? Math.abs(Math.sin(phase.current)) * 0.05 * (1 + sp) : 0);
    if (body.current) body.current.rotation.x = sp > 1.2 ? 0.16 : moving ? 0.05 : 0;
    // Subtle head life: a slow look-around when idle, a faint rhythm when moving.
    if (head.current) head.current.rotation.y = moving ? Math.sin(phase.current * 0.5) * 0.05 : Math.sin(clock.current * 0.7) * 0.07;

    // Stand still too long and the character gets restless: every ~9s it either
    // scratches its head or does a happy double-hop.
    if (!moving && idleFor.current > 12) {
      const cycle = (idleFor.current - 12) % 9;
      const which = Math.floor((idleFor.current - 12) / 9) % 2;
      if (cycle < 2.2) {
        const f = cycle / 2.2;
        const ease = Math.sin(Math.min(f * 3, 1) * Math.PI * 0.5) * Math.sin(Math.min((1 - f) * 3, 1) * Math.PI * 0.5);
        if (which === 0) {
          // Head scratch: right arm up beside the head, little wiggle, head tilts.
          if (armR.current) {
            armR.current.rotation.x = -2.5 * ease;
            armR.current.rotation.z = (-0.45 + Math.sin(clock.current * 14) * 0.12) * ease;
          }
          if (head.current) head.current.rotation.z = 0.16 * ease;
        } else {
          // Double-hop with arms swinging up.
          const hop = Math.abs(Math.sin(f * Math.PI * 2)) * 0.22 * ease;
          if (body.current) body.current.position.y = hop;
          if (armL.current) armL.current.rotation.x = -0.9 * ease;
          if (armR.current) armR.current.rotation.x = -0.9 * ease;
        }
      }
    }
    // Blink — the eyes squash shut for a moment every few seconds.
    if (eyes.current) eyes.current.scale.y = clock.current % 3.7 < 0.13 ? 0.12 : 1;
  });
  if (hidden) return null;

  const bodyW = 0.9;
  const shoulder = bodyW / 2 + 0.14;
  const leg = (ref: React.RefObject<THREE.Group | null>, x: number) => (
    <group ref={ref} position={[x, 0.8, 0]}>
      <mesh position={[0, -0.4, 0]} castShadow>
        <boxGeometry args={[0.36, 0.8, 0.42]} />
        <meshStandardMaterial color={look.pants} roughness={0.9} />
      </mesh>
      {/* Two-part shoe: upper + darker sole */}
      <mesh position={[0, -0.8, 0.03]} castShadow>
        <boxGeometry args={[0.4, 0.14, 0.5]} />
        <meshStandardMaterial color="#3a3a44" roughness={0.8} />
      </mesh>
      <mesh position={[0, -0.89, 0.03]}>
        <boxGeometry args={[0.42, 0.06, 0.52]} />
        <meshStandardMaterial color="#23232b" roughness={0.9} />
      </mesh>
    </group>
  );
  const arm = (ref: React.RefObject<THREE.Group | null>, x: number) => (
    <group ref={ref} position={[x, 0.85, 0]}>
      <mesh position={[0, -0.38, 0]} castShadow>
        <boxGeometry args={[0.26, 0.78, 0.4]} />
        <meshStandardMaterial color={look.shirt} roughness={0.85} />
      </mesh>
      {/* Sleeve cuff */}
      <mesh position={[0, -0.72, 0]}>
        <boxGeometry args={[0.28, 0.1, 0.42]} />
        <meshStandardMaterial color={shade(look.shirt, 0.72)} roughness={0.85} />
      </mesh>
      <mesh position={[0, -0.84, 0]} castShadow>
        <boxGeometry args={[0.28, 0.16, 0.42]} />
        <meshStandardMaterial color={look.skin} roughness={0.9} />
      </mesh>
    </group>
  );
  return (
    <group ref={body} scale={0.74}>
      {leg(legL, -0.2)}
      {leg(legR, 0.2)}
      {/* Belt between torso and legs */}
      <mesh position={[0, 0.84, 0]}>
        <boxGeometry args={[bodyW + 0.03, 0.12, 0.51]} />
        <meshStandardMaterial color="#4a3626" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.84, 0.26]}>
        <boxGeometry args={[0.14, 0.1, 0.02]} />
        <meshStandardMaterial color="#d9b45a" metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Upper body — bobs while walking */}
      <group ref={torso} position={[0, 0.8, 0]}>
        {look.flair === "rod" && (
          <group position={[0.05, 0.25, -0.33]} rotation={[0.25, 0, -0.55]}>
            <mesh>
              <cylinderGeometry args={[0.025, 0.035, 1.5, 6]} />
              <meshStandardMaterial color="#7a4f26" roughness={0.85} />
            </mesh>
            <mesh position={[0, 0.5, 0]}>
              <cylinderGeometry args={[0.032, 0.032, 0.12, 6]} />
              <meshStandardMaterial color="#3a3f4a" metalness={0.4} roughness={0.5} />
            </mesh>
          </group>
        )}
        {/* Torso */}
        <mesh position={[0, 0.45, 0]} castShadow>
          <boxGeometry args={[bodyW, 0.9, 0.48]} />
          <meshStandardMaterial color={look.shirt} roughness={0.85} />
        </mesh>
        {/* Collar + button placket for a two-tone shirt */}
        <mesh position={[0, 0.84, 0]}>
          <boxGeometry args={[bodyW * 0.72, 0.09, 0.52]} />
          <meshStandardMaterial color={shade(look.shirt, 0.72)} roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.42, 0.245]}>
          <boxGeometry args={[0.1, 0.78, 0.02]} />
          <meshStandardMaterial color={shade(look.shirt, 0.8)} roughness={0.85} />
        </mesh>
        {[0.62, 0.44, 0.26].map((y, i) => (
          <mesh key={i} position={[0, y, 0.255]}>
            <boxGeometry args={[0.05, 0.05, 0.02]} />
            <meshStandardMaterial color={shade(look.shirt, 0.55)} roughness={0.7} />
          </mesh>
        ))}
        {arm(armL, -shoulder)}
        {arm(armR, shoulder)}
        {/* Head (cube) — forward = +Z, looks around subtly */}
        <group ref={head} position={[0, 0.9, 0]}>
          <mesh position={[0, 0.4, 0]} castShadow>
            <boxGeometry args={[0.8, 0.8, 0.8]} />
            <meshStandardMaterial color={look.skin} roughness={0.95} />
          </mesh>
          {/* Eyes — whites + pupils (squash to blink), with brows */}
          <group ref={eyes} position={[0, 0.44, 0]}>
            {[-0.17, 0.17].map((x, i) => (
              <group key={i} position={[x, 0, 0.41]}>
                <mesh>
                  <boxGeometry args={[0.14, 0.16, 0.02]} />
                  <meshStandardMaterial color="#ffffff" roughness={0.3} />
                </mesh>
                <mesh position={[x > 0 ? 0.02 : -0.02, -0.01, 0.012]}>
                  <boxGeometry args={[0.07, 0.09, 0.02]} />
                  <meshStandardMaterial color="#2a2320" roughness={0.4} />
                </mesh>
              </group>
            ))}
          </group>
          {[-0.17, 0.17].map((x, i) => (
            <mesh key={i} position={[x, 0.56, 0.41]}>
              <boxGeometry args={[0.15, 0.04, 0.02]} />
              <meshStandardMaterial color={look.hairStyle === "none" ? shade(look.skin, 0.7) : look.hair} roughness={1} />
            </mesh>
          ))}
          {/* Nose + mouth */}
          <mesh position={[0, 0.33, 0.42]}>
            <boxGeometry args={[0.08, 0.09, 0.05]} />
            <meshStandardMaterial color={shade(look.skin, 0.88)} roughness={0.95} />
          </mesh>
          <mesh position={[0, 0.2, 0.41]}>
            <boxGeometry args={[0.16, 0.04, 0.02]} />
            <meshStandardMaterial color="#9c5a4a" roughness={0.8} />
          </mesh>
          <BlockHair style={look.hairStyle} color={look.hair} under={look.hatStyle !== "none"} />
          <BlockHat style={look.hatStyle} color={look.hat} />
          {look.flair === "crown" && (
            <group position={[0, 0.98, 0]}>
              <mesh>
                <cylinderGeometry args={[0.24, 0.26, 0.12, 8]} />
                <meshStandardMaterial color="#e2ae3c" metalness={0.55} roughness={0.35} />
              </mesh>
              {[0, 1, 2, 3, 4].map((i) => {
                const a = (i / 5) * Math.PI * 2;
                return (
                  <mesh key={i} position={[Math.cos(a) * 0.24, 0.11, Math.sin(a) * 0.24]}>
                    <coneGeometry args={[0.045, 0.13, 4]} />
                    <meshStandardMaterial color="#e2ae3c" metalness={0.55} roughness={0.35} />
                  </mesh>
                );
              })}
              <mesh position={[0, 0.02, 0.26]}>
                <sphereGeometry args={[0.035, 6, 6]} />
                <meshStandardMaterial color="#c0392b" roughness={0.4} />
              </mesh>
            </group>
          )}
        </group>
      </group>
    </group>
  );
}

// Free a CanvasTexture when it's replaced (text changed) or the component
// unmounts. These get rebuilt on every nameplate/chat/live-status change, so
// without disposal they leak GPU memory — negligible in a short visit, but it
// accumulates over a multi-hour session (a stream, a left-open tab). Disposes
// only the OUTGOING texture, after React has swapped in the new one.
function useDisposeOnChange(resource: { dispose(): void } | null | undefined): void {
  useEffect(() => () => resource?.dispose?.(), [resource]);
}

// A billboard nameplate floating above the avatar, drawn from a canvas texture
// (no DOM, always faces the camera).
function NamePlate({ text }: { text: string }) {
  const built = useMemo(() => {
    // The plate grows with the name — long names render in full at the same
    // font size instead of clipping at a fixed canvas edge.
    const c = document.createElement("canvas");
    const meas = c.getContext("2d")!;
    meas.font = "bold 30px system-ui, sans-serif";
    const w = Math.max(150, Math.ceil(meas.measureText(text).width) + 52);
    c.width = w;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    const r = 16;
    ctx.beginPath();
    ctx.moveTo(r, 4);
    ctx.arcTo(w - 4, 4, w - 4, 60, r);
    ctx.arcTo(w - 4, 60, 4, 60, r);
    ctx.arcTo(4, 60, 4, 4, r);
    ctx.arcTo(4, 4, w - 4, 4, r);
    ctx.fill();
    ctx.font = "bold 30px system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, 34);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return { t, sx: 2.4 * (w / 256) };
  }, [text]);
  useDisposeOnChange(built.t);
  return (
    <sprite position={[0, 2.6, 0]} scale={[built.sx, 0.6, 1]}>
      <spriteMaterial map={built.t} transparent depthTest={false} />
    </sprite>
  );
}

// A speech/emote bubble above a character, drawn from a canvas texture. The
// bubble grows with the line (and wraps to two lines past a point) so text
// always renders in full — never shrunk to unreadable, never "…".
function SpeechBubble({ text }: { text: string }) {
  const built = useMemo(() => {
    const probe = document.createElement("canvas").getContext("2d")!;
    const FONT = "500 24px system-ui, sans-serif";
    probe.font = FONT;
    const fullW = probe.measureText(text).width;
    const MAXW = 460;
    // Wrap to two lines when one line would exceed the widest bubble we allow.
    let lines: string[] = [text];
    if (fullW + 36 > MAXW) {
      const words = text.split(" ");
      let best = 1;
      let bestDiff = Infinity;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(" ");
        const b = words.slice(i).join(" ");
        const diff = Math.abs(probe.measureText(a).width - probe.measureText(b).width);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
      }
      lines = [words.slice(0, best).join(" "), words.slice(best).join(" ")];
    }
    const lineW = Math.max(...lines.map((l) => probe.measureText(l).width));
    const w = Math.max(150, Math.min(MAXW, Math.ceil(lineW) + 36));
    const bodyH = lines.length === 2 ? 92 : 62;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = bodyH + 34;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    const x = 6, y = 6, bw = w - 12, r = 14;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + bw, y, x + bw, y + bodyH, r);
    ctx.arcTo(x + bw, y + bodyH, x, y + bodyH, r);
    ctx.arcTo(x, y + bodyH, x, y, r);
    ctx.arcTo(x, y, x + bw, y, r);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w / 2 - 10, y + bodyH - 2);
    ctx.lineTo(w / 2 + 10, y + bodyH - 2);
    ctx.lineTo(w / 2, y + bodyH + 16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#111827";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = FONT;
    lines.forEach((l, i) => ctx.fillText(l, w / 2, y + (lines.length === 2 ? 24 + i * 30 : bodyH / 2)));
    const tx = new THREE.CanvasTexture(c);
    tx.needsUpdate = true;
    return { tx, sx: 2.4 * (w / 256), sy: 0.9 * ((bodyH + 34) / 96) };
  }, [text]);
  useDisposeOnChange(built.tx);
  return (
    <sprite position={[0, 3.25, 0]} scale={[built.sx, built.sy, 1]}>
      <spriteMaterial map={built.tx} transparent depthTest={false} />
    </sprite>
  );
}

// Shows the transient bubble for a given player id (self or peer), toggling only
// when the text actually changes so we don't re-render every frame.
function BubbleFollower({ id, bubblesRef }: { id: string; bubblesRef: React.RefObject<Map<string, Bubble>> }) {
  const [text, setText] = useState<string | null>(null);
  const shown = useRef<string | null>(null);
  useFrame(() => {
    const b = bubblesRef.current?.get(id);
    const active = b && b.until > Date.now() ? b.text : null;
    if (active !== shown.current) { shown.current = active; setText(active); }
  });
  return text ? <SpeechBubble text={text} /> : null;
}

// A remote player — their avatar + nameplate + bubble, smoothly interpolated
// toward the latest pose the presence server relayed (positions arrive ~10Hz).
function Peer({ meta, posesRef, bubblesRef, playerRef }: { meta: PeerMeta; posesRef: React.RefObject<Map<string, PeerPose>>; bubblesRef: React.RefObject<Map<string, Bubble>>; playerRef?: { current: PeerPose } }) {
  const g = useRef<THREE.Group>(null);
  const nameG = useRef<THREE.Group>(null);
  const gait = useRef<Gait>({ speed: 0 });
  const cur = useRef<{ x: number; z: number; ry: number } | null>(null);
  const jumpT = useRef(0);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const t = posesRef.current?.get(meta.id);
    if (!t || !g.current) return;
    if (!cur.current) cur.current = { x: t.x, z: t.z, ry: t.ry };
    const k = 1 - Math.exp(-12 * dt);
    cur.current.x += (t.x - cur.current.x) * k;
    cur.current.z += (t.z - cur.current.z) * k;
    let d = t.ry - cur.current.ry;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    cur.current.ry += d * k;
    // Airtime is broadcast as a state, not a height — animate a hop locally so
    // jumps read on other screens.
    if (t.st === "jump") jumpT.current = Math.min(jumpT.current + dt, 0.62);
    else jumpT.current = Math.max(jumpT.current - dt * 3, 0);
    const hop = Math.sin(Math.min(jumpT.current / 0.62, 1) * Math.PI) * 0.85;
    g.current.position.set(cur.current.x, hop, cur.current.z);
    g.current.rotation.y = cur.current.ry;
    gait.current.speed = t.st === "run" ? 1.6 : t.st === "walk" ? 1 : 0;
    gait.current.mode = t.st === "sit" ? "sit" : t.st === "fish" ? "fish" : null;
    // Distance culling — same budget as the NPC villagers, so a crowded room
    // (a launch/stream rush) doesn't render ~25 avatar meshes per far-off peer.
    const p = playerRef?.current;
    if (p) {
      const pd = Math.hypot(p.x - cur.current.x, p.z - cur.current.z);
      g.current.visible = pd < 75;
      if (nameG.current) nameG.current.visible = pd < 40;
    }
  });
  return (
    <group ref={g}>
      <Avatar look={meta.look} gait={gait} hidden={false} />
      <group ref={nameG}>
        <NamePlate text={meta.name} />
        <BubbleFollower id={meta.id} bubblesRef={bubblesRef} />
      </group>
    </group>
  );
}

function Peers({ peerList, posesRef, bubblesRef, playerRef }: { peerList: PeerMeta[]; posesRef: React.RefObject<Map<string, PeerPose>>; bubblesRef: React.RefObject<Map<string, Bubble>>; playerRef?: { current: PeerPose } }) {
  return (
    <>
      {peerList.map((p) => (
        <Peer key={p.id} meta={p} posesRef={posesRef} bubblesRef={bubblesRef} playerRef={playerRef} />
      ))}
    </>
  );
}

// A golden crown floating over this epoch's #1 agent's house (recognition only).
function Crown({ position }: { position: [number, number, number] }) {
  const g = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (g.current) {
      g.current.position.y = 7.3 + Math.sin(state.clock.elapsedTime * 2) * 0.2;
      g.current.rotation.y = state.clock.elapsedTime * 0.8;
    }
  });
  return (
    <group ref={g} position={[position[0], 7.3, position[2]]}>
      <mesh>
        <cylinderGeometry args={[0.5, 0.5, 0.3, 12, 1, true]} />
        <meshStandardMaterial color="#f6c945" emissive="#e0a800" emissiveIntensity={0.9} metalness={0.6} roughness={0.3} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * 0.5, 0.28, Math.sin(a) * 0.5]}>
            <coneGeometry args={[0.12, 0.32, 6]} />
            <meshStandardMaterial color="#f6c945" emissive="#e0a800" emissiveIntensity={0.9} metalness={0.6} roughness={0.3} toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}

// ——— Fishing minigame ————————————————————————————————————————————————————————
// Stand at a dock (fish spot), press E to cast: the bobber floats, then dips
// with a "!" — press E inside the reaction window to land a catch from the
// weighted loot table. Wander off and the line reels itself in.
export type FishPrompt = "none" | "cast" | "wait" | "bite";

function FishingManager({
  spots,
  poseRef,
  cancelRef,
  onCatch,
  onPrompt,
  onState,
}: {
  spots: FishSpot[];
  poseRef: { current: PeerPose };
  cancelRef: React.RefObject<number>;
  onCatch: (item: ItemDef) => void;
  onPrompt: (p: FishPrompt) => void;
  onState: (spot: FishSpot | null) => void;
}) {
  const spotsRef = useRef(spots);
  useEffect(() => { spotsRef.current = spots; }, [spots]);
  const phase = useRef<"idle" | "wait" | "bite">("idle");
  const active = useRef<FishSpot | null>(null);
  const near = useRef<FishSpot | null>(null);
  const timer = useRef(0);
  const lastCancel = useRef(0);
  const shown = useRef<FishPrompt>("none");
  const bobber = useRef<THREE.Group>(null);
  const alertRef = useRef<THREE.Sprite>(null);
  const splash = useRef<THREE.Mesh>(null);
  const rod = useRef<THREE.Group>(null);

  // The fishing line — two points updated every frame (rod tip → bobber).
  const lineObj = useMemo(
    () =>
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: "#f0f0f0", transparent: true, opacity: 0.7 }),
      ),
    [],
  );
  const lineRef = useRef<THREE.Line>(null);

  const alertTex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#f43f5e";
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 40px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("!", 32, 35);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, []);

  const report = (p: FishPrompt) => {
    if (shown.current !== p) { shown.current = p; onPrompt(p); }
  };

  const endCast = useCallback(() => {
    phase.current = "idle";
    active.current = null;
    onState(null);
  }, [onState]);

  // Waits get longer with every fish landed at the dock in one session, so the
  // catch rate can't be farmed too hard. Reset on a fresh cast.
  const catches = useRef(0);
  const nextWait = useCallback(() => 4 + Math.random() * 5 + Math.min(catches.current * 1.5, 8), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.code !== "KeyE") return;
      if (phase.current === "idle" && near.current) {
        active.current = near.current;
        phase.current = "wait";
        catches.current = 0;
        timer.current = nextWait();
        onState(near.current); // locks the player onto the dock, cinematic on
      } else if (phase.current === "bite") {
        onCatch(rollCatch());
        catches.current++;
        // Keep fishing — the line recasts itself. Walking away is the only exit,
        // so a slightly-late E on a bite can't accidentally quit the session.
        phase.current = "wait";
        timer.current = nextWait();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCatch, onState, nextWait]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    const p = poseRef.current;
    // Which dock are we standing at? (While casting, we're locked at sx/sz —
    // still within trigger range of the same spot.)
    let found: FishSpot | null = null;
    for (const s of spotsRef.current) {
      if (Math.hypot(p.x - s.x, p.z - s.z) < 3.2) { found = s; break; }
    }
    near.current = found;
    // A movement key while locked asks us to reel in.
    if (cancelRef.current !== lastCancel.current) {
      lastCancel.current = cancelRef.current;
      if (phase.current !== "idle") endCast();
    }
    if (phase.current === "wait") {
      timer.current -= dt;
      if (timer.current <= 0) { phase.current = "bite"; timer.current = 0.8; }
    } else if (phase.current === "bite") {
      timer.current -= dt;
      if (timer.current <= 0) {
        // It got away — the line recasts itself and the wait starts over.
        phase.current = "wait";
        timer.current = nextWait();
      }
    }
    report(phase.current === "idle" ? (found ? "cast" : "none") : phase.current);

    // Bobber, rod, line + effects.
    const s = active.current;
    const casting = !!s && phase.current !== "idle";
    const dip = phase.current === "bite" ? -0.16 : 0;
    const bobY = 0.12 + Math.sin(t * 2.2) * 0.045 + dip;
    const g = bobber.current;
    if (g) {
      g.visible = casting;
      if (s) g.position.set(s.bx, bobY, s.bz);
    }
    if (rod.current) {
      rod.current.visible = casting;
      if (s) {
        rod.current.position.set(s.sx, 0, s.sz);
        rod.current.rotation.y = s.ry;
      }
    }
    const line = lineRef.current;
    if (line) {
      line.visible = casting;
      if (s && casting) {
        const tipX = s.sx + Math.sin(s.ry) * 1.75;
        const tipZ = s.sz + Math.cos(s.ry) * 1.75;
        const posAttr = line.geometry.attributes.position as THREE.BufferAttribute;
        posAttr.setXYZ(0, tipX, 2.08, tipZ);
        posAttr.setXYZ(1, s.bx, bobY + 0.1, s.bz);
        posAttr.needsUpdate = true;
      }
    }
    if (alertRef.current) alertRef.current.visible = phase.current === "bite";
    if (splash.current) {
      const vis = phase.current === "bite";
      splash.current.visible = vis;
      if (vis) {
        const ph = (t * 1.6) % 1;
        splash.current.scale.setScalar(0.5 + ph * 1.3);
        (splash.current.material as THREE.MeshBasicMaterial).opacity = (1 - ph) * 0.5;
      }
    }
  });

  return (
    <group>
      <group ref={bobber} visible={false}>
        {/* Red-and-white bobber */}
        <mesh position={[0, 0.05, 0]}>
          <sphereGeometry args={[0.11, 10, 10]} />
          <meshStandardMaterial color="#e5e7eb" roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.13, 0]}>
          <sphereGeometry args={[0.1, 10, 10]} />
          <meshStandardMaterial color="#ef4444" roughness={0.4} />
        </mesh>
        <sprite ref={alertRef} position={[0, 1.1, 0]} scale={[0.6, 0.6, 1]} visible={false}>
          <spriteMaterial map={alertTex} transparent depthTest={false} />
        </sprite>
        <mesh ref={splash} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
          <ringGeometry args={[0.5, 0.65, 20]} />
          <meshBasicMaterial color="#e8f6fd" transparent opacity={0.5} toneMapped={false} />
        </mesh>
      </group>
      {/* Fishing rod in the player's hands (angled out over the water) + line */}
      <group ref={rod} visible={false}>
        <group position={[0.22, 1.02, 0.32]} rotation={[0.92, 0, 0]}>
          <mesh position={[0, 0.9, 0]}>
            <cylinderGeometry args={[0.022, 0.045, 1.9, 6]} />
            <meshStandardMaterial color="#6b4a2a" roughness={0.8} />
          </mesh>
          {/* Grip + reel */}
          <mesh position={[0, 0.05, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.3, 6]} />
            <meshStandardMaterial color="#3a3a44" roughness={0.7} />
          </mesh>
          <mesh position={[0.05, 0.28, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.07, 0.07, 0.05, 10]} />
            <meshStandardMaterial color="#8a8a94" metalness={0.5} roughness={0.4} />
          </mesh>
        </group>
      </group>
      <primitive object={lineObj} ref={lineRef} />
    </group>
  );
}

// ——— Ring Run minigame ———————————————————————————————————————————————————————
// A start post near the plaza; press E and a circle of glowing rings appears
// around the town centre. Run through them in order against the clock — beat
// your best time and a trophy lands in your inventory.
const RING_COUNT = 10;
const RING_RADIUS = 19;

export interface RingRunState {
  running: boolean;
  startedAt: number;
  idx: number;
  finishedMs: number | null;
  best: number | null;
}

type RingPoint = { x: number; z: number; y: number; a: number };

// Ten different route shapes — one is rolled at random each run. Every ring is
// nudged clear of anything solid (houses, trees, ponds…) so it's easy to hit.
function makeRingRoute(style: number, startAngle: number, obstacles: Collider[]): RingPoint[] {
  const pts: RingPoint[] = [];
  for (let i = 0; i < RING_COUNT; i++) {
    let a = startAngle + (i / RING_COUNT) * Math.PI * 2;
    let r = RING_RADIUS;
    let y = 1.25;
    switch (style) {
      case 1: r = 27; break; // wide loop
      case 2: r = i % 2 ? 27 : 15; break; // star: in-out-in-out
      case 3: r = 14 + i * 2; break; // spiral outward
      case 4: r = 32 - i * 2; break; // spiral inward
      case 5: r = 21 + Math.sin(i * 1.26) * 6; break; // gentle waves
      case 6: r = 20; y = i % 2 ? 2.3 : 1.15; break; // jump hops
      case 7: r = 14.5; y = 1.4; break; // tight sprint
      case 8: r = 19 + Math.sin(i * 2.51) * 7; break; // wild lobes
      case 9: r = 23; y = 1.1 + i * 0.16; break; // the climb
    }
    for (let t = 0; t < 30; t++) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (obstacles.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + 2.2)) break;
      a += 0.06;
    }
    pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, y, a });
  }
  return pts;
}

function RingRun({
  postAngle,
  poseRef,
  obstacles,
  onEvent,
}: {
  postAngle: number;
  poseRef: { current: PeerPose };
  obstacles: Collider[];
  onEvent: (e: { type: "start" } | { type: "progress"; idx: number } | { type: "finish"; ms: number; best: boolean }) => void;
}) {
  const [idx, setIdx] = useState(-1); // -1 = not running
  const idxRef = useRef(-1);
  const t0 = useRef(0);
  const glow = useRef<THREE.Group>(null);
  const [rings, setRings] = useState<RingPoint[]>([]);
  const ringsRef = useRef<RingPoint[]>([]);
  useEffect(() => { ringsRef.current = rings; }, [rings]);
  const obstaclesRef = useRef(obstacles);
  useEffect(() => { obstaclesRef.current = obstacles; }, [obstacles]);

  const post: [number, number] = useMemo(
    () => [Math.cos(postAngle) * (RING_RADIUS - 4.5), Math.sin(postAngle) * (RING_RADIUS - 4.5)],
    [postAngle],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.code !== "KeyE") return;
      if (idxRef.current >= 0) return; // already running
      const p = poseRef.current;
      if (Math.hypot(p.x - post[0], p.z - post[1]) < 2.6) {
        // Roll one of the ten route styles for this run.
        setRings(makeRingRoute(Math.floor(Math.random() * 10), postAngle, obstaclesRef.current));
        idxRef.current = 0;
        setIdx(0);
        t0.current = Date.now();
        onEvent({ type: "start" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [post, postAngle, poseRef, onEvent]);

  useFrame((state) => {
    const i = idxRef.current;
    const route = ringsRef.current;
    if (i >= 0 && i < RING_COUNT && route.length === RING_COUNT) {
      const r = route[i];
      const p = poseRef.current;
      if (Math.hypot(p.x - r.x, p.z - r.z) < 2) {
        const next = i + 1;
        idxRef.current = next;
        setIdx(next);
        if (next === RING_COUNT) {
          const ms = Date.now() - t0.current;
          let best = false;
          try {
            const prev = Number(localStorage.getItem("axon-ringrun-best") ?? 0);
            if (!prev || ms < prev) { localStorage.setItem("axon-ringrun-best", String(ms)); best = true; }
          } catch { /* storage unavailable */ }
          onEvent({ type: "finish", ms, best });
          idxRef.current = -1;
          setIdx(-1);
        } else {
          onEvent({ type: "progress", idx: next });
        }
      }
    }
    // The active ring pulses.
    if (glow.current) {
      const s = 1 + Math.sin(state.clock.elapsedTime * 5) * 0.07;
      glow.current.scale.set(s, s, s);
    }
  });

  return (
    <group>
      {/* Start post: striped pole, flag + board */}
      <group position={[post[0], 0, post[1]]}>
        <mesh position={[0, 1.3, 0]} castShadow>
          <cylinderGeometry args={[0.11, 0.13, 2.6, 8]} />
          <meshStandardMaterial color="#e8e2d4" roughness={0.8} />
        </mesh>
        {[0.5, 1.1, 1.7, 2.3].map((y, i) => (
          <mesh key={i} position={[0, y, 0]}>
            <cylinderGeometry args={[0.12, 0.12, 0.3, 8]} />
            <meshStandardMaterial color="#14b8a6" roughness={0.8} />
          </mesh>
        ))}
        <mesh position={[0.4, 2.42, 0]}>
          <boxGeometry args={[0.8, 0.42, 0.04]} />
          <meshStandardMaterial color="#14b8a6" emissive="#0d9488" emissiveIntensity={0.5} roughness={0.6} />
        </mesh>
      </group>
      {/* Rings appear while running */}
      {idx >= 0 &&
        rings.map((r, i) => {
          const isActive = i === idx;
          const done = i < idx;
          return (
            <group key={i} position={[r.x, r.y, r.z]} rotation={[0, -r.a + Math.PI / 2, 0]} ref={isActive ? glow : undefined}>
              <mesh>
                <torusGeometry args={[1.35, 0.09, 10, 32]} />
                <meshStandardMaterial
                  color={done ? "#6b7280" : "#2dd4bf"}
                  emissive={done ? "#374151" : "#14b8a6"}
                  emissiveIntensity={isActive ? 1.8 : done ? 0.1 : 0.5}
                  toneMapped={false}
                />
              </mesh>
            </group>
          );
        })}
    </group>
  );
}

// Watches the gather spots (orchard trees, berry bushes): reports which kind is
// in reach for the HUD prompt, and hands out food on E with a per-spot cooldown.
function GatherManager({
  spots,
  poseRef,
  onGather,
  onNear,
}: {
  spots: GatherSpot[];
  poseRef: { current: PeerPose };
  onGather: (kind: "apple" | "berry" | "dig") => void;
  onNear: (kind: "apple" | "berry" | "dig" | null) => void;
}) {
  const spotsRef = useRef(spots);
  useEffect(() => { spotsRef.current = spots; }, [spots]);
  const cooldown = useRef(new Map<string, number>());
  const nearRef = useRef<GatherSpot | null>(null);
  const shown = useRef<"apple" | "berry" | "dig" | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.code !== "KeyE") return;
      const s = nearRef.current;
      if (!s) return;
      cooldown.current.set(s.id, Date.now() + 75_000); // this tree/bush needs to regrow
      onGather(s.kind);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onGather]);
  useFrame(() => {
    const p = poseRef.current;
    let best: GatherSpot | null = null;
    let bestD = 2.8;
    const now = Date.now();
    for (const s of spotsRef.current) {
      if ((cooldown.current.get(s.id) ?? 0) > now) continue;
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    nearRef.current = best;
    const kind = best?.kind ?? null;
    if (kind !== shown.current) { shown.current = kind; onNear(kind); }
  });
  return null;
}

// Watches for the player nearing an unopened gift chest (at active agents'
// houses) — E claims the daily gift. Mirrors GatherManager's shape.
function ChestManager({
  spots,
  openedRef,
  poseRef,
  onOpen,
  onNear,
}: {
  spots: { id: string; x: number; z: number }[];
  openedRef: { current: Set<string> };
  poseRef: { current: PeerPose };
  onOpen: (id: string) => void;
  onNear: (id: string | null) => void;
}) {
  const spotsRef = useRef(spots);
  useEffect(() => { spotsRef.current = spots; }, [spots]);
  const nearRef = useRef<string | null>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.code !== "KeyE") return;
      if (nearRef.current) onOpen(nearRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
  useFrame(() => {
    const p = poseRef.current;
    let best: string | null = null;
    let bestD = 2.1;
    for (const s of spotsRef.current) {
      if (openedRef.current.has(s.id)) continue;
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < bestD) { bestD = d; best = s.id; }
    }
    nearRef.current = best;
    if (best !== shown.current) { shown.current = best; onNear(best); }
  });
  return null;
}

// Show children only within `range` of the player — a per-frame visibility
// flip on a group, no React re-renders. The cheap knife behind the culls.
function RangedVisible({ x, z, range, poseRef, children }: { x: number; z: number; range: number; poseRef: { current: PeerPose }; children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const p = poseRef.current;
    if (g.current) g.current.visible = Math.hypot(p.x - x, p.z - z) < range;
  });
  return <group ref={g}>{children}</group>;
}

// Dev perf probe: samples FPS + renderer counters twice a second while the
// overlay is open. Costs nothing when hidden (not mounted).
function StatsProbe({ onStats }: { onStats: (s: { fps: number; calls: number; tris: number; census: string[] }) => void }) {
  const { gl, scene } = useThree();
  const acc = useRef({ t: 0, frames: 0 });
  useEffect(() => {
    // The EffectComposer renders several passes; with autoReset the counters
    // are wiped before we can read them (hence "1 call"). Accumulate manually.
    /* eslint-disable react-hooks/immutability */
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
    /* eslint-enable react-hooks/immutability */
  }, [gl]);
  // Priority -1000: run FIRST each frame — read the whole previous frame's
  // accumulated counters, report, then reset for the coming frame.
   
  useFrame((_, dt) => {
    acc.current.t += dt;
    acc.current.frames++;
    if (acc.current.t >= 0.5) {
      // Census: everything that WOULD render (visible up the chain), grouped
      // by geometry type — the draw-call population names itself.
      const counts = new Map<string, number>();
      scene.traverse((o) => {
        const anyO = o as THREE.Mesh & { isMesh?: boolean; isSprite?: boolean; isPoints?: boolean; isInstancedMesh?: boolean };
        if (!anyO.visible) return;
        let kind: string | null = null;
        if (anyO.isInstancedMesh) kind = `Inst(${(anyO.geometry as THREE.BufferGeometry | undefined)?.type?.replace("Geometry", "") ?? "?"})`;
        else if (anyO.isMesh) kind = (anyO.geometry as THREE.BufferGeometry | undefined)?.type?.replace("Geometry", "") ?? "Mesh";
        else if (anyO.isSprite) kind = "Sprite";
        else if (anyO.isPoints) kind = "Points";
        if (!kind) return;
        // visibility must hold up the ancestor chain; grab the nearest name
        let label: string | null = null;
        let a: THREE.Object3D | null = o.parent;
        while (a) {
          if (!a.visible) return;
          if (!label && a.name) label = a.name;
          a = a.parent;
        }
        counts.set(label ?? kind, (counts.get(label ?? kind) ?? 0) + 1);
      });
      const census = [...counts.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 8)
        .map(([k, n]) => `${k}×${n}`);
      onStats({
        fps: Math.round(acc.current.frames / acc.current.t),
        calls: gl.info.render.calls,
        tris: gl.info.render.triangles,
        census,
      });
      acc.current.t = 0;
      acc.current.frames = 0;
    }
    gl.info.reset();
  }, -1000);
  return null;
}

// Tracks whether the player stands near the FRONT DOOR of the nearest house —
// the knock hint only appears where knocking actually works.
function NearDoorManager({
  poseRef,
  nearestKeyRef,
  buildingsRef,
  onNear,
}: {
  poseRef: { current: PeerPose };
  nearestKeyRef: { current: string | null };
  buildingsRef: { current: WorldBuilding[] };
  onNear: (near: boolean) => void;
}) {
  const shown = useRef(false);
  useFrame(() => {
    const key = nearestKeyRef.current;
    let near = false;
    if (key) {
      const b = buildingsRef.current.find((bb) => bb.key === key);
      if (b) {
        const rot = b.rot ?? 0;
        const w = b.w ?? 4;
        const dx = b.x + Math.sin(rot) * (w / 2 + 0.6);
        const dz = b.z + Math.cos(rot) * (w / 2 + 0.6);
        near = Math.hypot(poseRef.current.x - dx, poseRef.current.z - dz) < 4.2;
      }
    }
    if (near !== shown.current) {
      shown.current = near;
      onNear(near);
    }
  });
  return null;
}

// Proximity watcher for the plaza job board — E opens the live board panel.
// ——— Mobile touch controls ———————————————————————————————————————————————————
// Left thumb: virtual joystick (push to the rim to run). Dragging anywhere on
// the world looks around (the existing canvas drag — with pitch in first
// person). The buttons dispatch REAL KeyboardEvents, so jumping, E-interactions
// and knocking reuse every existing handler untouched.
function pressKey(code: string, holdMs = 140) {
  window.dispatchEvent(new KeyboardEvent("keydown", { code }));
  window.setTimeout(() => window.dispatchEvent(new KeyboardEvent("keyup", { code })), holdMs);
}

function TouchControls({ touchRef }: { touchRef: { current: { mx: number; my: number; run: boolean } } }) {
  const knobRef = useRef<HTMLDivElement>(null);
  const pid = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const R = 44;
  const setKnob = (dx: number, dy: number) => {
    if (knobRef.current) knobRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    pid.current = e.pointerId;
    origin.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (pid.current !== e.pointerId) return;
    e.stopPropagation();
    let dx = e.clientX - origin.current.x;
    let dy = e.clientY - origin.current.y;
    const m = Math.hypot(dx, dy);
    if (m > R) { dx = (dx / m) * R; dy = (dy / m) * R; }
    setKnob(dx, dy);
    const t = touchRef.current;
    t.mx = dx / R;
    t.my = -dy / R; // screen-up = forward
    t.run = m > R * 0.88;
  };
  const end = (e: React.PointerEvent) => {
    if (pid.current !== e.pointerId) return;
    pid.current = null;
    setKnob(0, 0);
    const t = touchRef.current;
    t.mx = 0; t.my = 0; t.run = false;
  };
  const btn = "rounded-full border-2 text-white font-bold backdrop-blur-[2px] select-none flex items-center justify-center";
  return (
    <>
      <div
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        className="absolute bottom-24 left-5 w-32 h-32 rounded-full bg-white/10 border-2 border-white/25 backdrop-blur-[2px] z-30"
        style={{ touchAction: "none" }}
      >
        <div ref={knobRef} className="absolute left-1/2 top-1/2 -ml-7 -mt-7 w-14 h-14 rounded-full bg-white/40 border border-white/50 pointer-events-none" />
      </div>
      <div className="absolute bottom-24 right-4 flex flex-col items-center gap-3 z-30" style={{ touchAction: "none" }}>
        <button onPointerDown={(e) => { e.stopPropagation(); pressKey("KeyK"); }} className={`${btn} w-14 h-14 bg-white/15 border-white/30 text-[11px]`}>KNOCK</button>
        <button onPointerDown={(e) => { e.stopPropagation(); pressKey("KeyE"); }} className={`${btn} w-16 h-16 bg-teal-500/60 border-teal-200/60 text-sm`}>USE</button>
        <button onPointerDown={(e) => { e.stopPropagation(); pressKey("Space", 180); }} className={`${btn} w-16 h-16 bg-white/15 border-white/30 text-[11px]`}>JUMP</button>
      </div>
    </>
  );
}

// One-shot shader warm-up: compile EVERY mounted material while the boot
// overlay still covers the screen. Distance-gated layers only flip visibility
// (they stay mounted), so this reaches them too. Without it, phones freeze
// for seconds whenever a material family first enters the camera mid-walk.
function WarmUp({ ready }: { ready: boolean }) {
  const { gl, scene, camera } = useThree();
  const done = useRef(false);
  useFrame(() => {
    if (done.current || !ready) return;
    done.current = true;
    try {
      gl.compile(scene, camera);
    } catch {
      /* best effort — a failed warm-up just means lazy compiles as before */
    }
  });
  return null;
}

// Adaptive quality: watch the REAL frame rate and step the quality ladder
// down for machines that can't hold it — tier 1 drops post-processing and
// render scale, tier 2 also drops sun shadows. Sticky (never steps back up)
// so quality doesn't flap; strong machines never leave tier 0.
function QualityGovernor({ onTier }: { onTier: (tier: number) => void }) {
  const frames = useRef(0);
  const windowStart = useRef(0);
  const lowWindows = useRef(0);
  const tier = useRef(0);
  useFrame((state) => {
    frames.current++;
    const now = state.clock.elapsedTime;
    if (windowStart.current === 0) windowStart.current = now;
    const span = now - windowStart.current;
    if (span < 2) return;
    const fps = frames.current / span;
    frames.current = 0;
    windowStart.current = now;
    // Let load-in jank settle before judging the machine.
    if (now < 8 || tier.current >= 2) return;
    if (fps < (tier.current === 0 ? 38 : 26)) lowWindows.current++;
    else lowWindows.current = 0;
    if (lowWindows.current >= 2) {
      lowWindows.current = 0;
      tier.current++;
      onTier(tier.current);
    }
  });
  return null;
}

function BoardManager({
  spot,
  poseRef,
  onOpen,
  onNear,
}: {
  spot: { x: number; z: number } | null;
  poseRef: { current: PeerPose };
  onOpen: () => void;
  onNear: (near: boolean) => void;
}) {
  const spotRef = useRef(spot);
  useEffect(() => { spotRef.current = spot; }, [spot]);
  const nearRef = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.code !== "KeyE") return;
      if (nearRef.current) onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
  useFrame(() => {
    const s = spotRef.current;
    const p = poseRef.current;
    const near = !!s && Math.hypot(p.x - s.x, p.z - s.z) < 2.6;
    if (near !== nearRef.current) { nearRef.current = near; onNear(near); }
  });
  return null;
}

// Where the hidden home interior lives: far outside the city, still inside
// the presence server's coordinate clamp.
// Touch device? Drives the mobile controls, disables pointer lock (not a
// thing on phones) and gates the world behind landscape orientation.
const IS_TOUCH = typeof navigator !== "undefined" && (navigator.maxTouchPoints > 0 || "ontouchstart" in globalThis);

// Bottom-centre HUD chips stay at the screen's bottom edge everywhere — the
// joystick and buttons sit HIGHER (bottom-24) so they never cover the chips.
const CHIP_BOTTOM = "bottom-4";
// Modal overlays: on touch they anchor to the TOP and stop well above the
// joystick zone; on desktop they stay centered exactly as before.
const PANEL_WRAP = IS_TOUCH
  ? "absolute inset-0 z-20 flex items-start justify-center pt-3 px-3 pb-28"
  : "absolute inset-0 z-20 flex items-center justify-center p-6";
const PANEL_MAXH = IS_TOUCH ? "max-h-[66vh]" : "max-h-[85vh]";

const INTERIOR_POS = { x: 560, z: 560 };
// You can't walk through the furniture — room-local offsets from INTERIOR_POS,
// matched to the HomeInterior layout below.
const INTERIOR_SOLIDS: { x: number; z: number; r: number }[] = [
  { x: -3.6, z: -3.6, r: 1.7 }, // bed
  { x: -1.9, z: -4.85, r: 0.65 }, // bedside table
  { x: 3.7, z: -4.55, r: 1.45 }, // desk + monitor
  { x: 3.7, z: -3.4, r: 0.55 }, // chair
  { x: 4.7, z: 1.6, r: 1.35 }, // fireplace
  { x: -4.5, z: 2.6, r: 0.85 }, // trophy stand
  { x: -4.9, z: 0.9, r: 1.05 }, // bookshelf
  { x: 4.6, z: 4.4, r: 0.55 }, // potted plant
];

// The receipts wall: an agent's recent completed work hangs framed above the
// bed; every certificate is a real task and clicking it opens the public
// /r/<taskId> proof page. The house is the agent's portfolio.
interface WallReceiptItem {
  taskId: string;
  counterparty: string;
  payment: string | null;
  completedAt: string;
}

function ReceiptFrame({ r, x }: { r: WallReceiptItem; x: number }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 192;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#101820";
    ctx.fillRect(0, 0, 256, 192);
    ctx.strokeStyle = "rgba(45,212,191,0.55)";
    ctx.lineWidth = 3;
    ctx.strokeRect(9, 9, 238, 174);
    ctx.textAlign = "center";
    ctx.fillStyle = "#2dd4bf";
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.fillText("AXON RECEIPT", 128, 40);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 20px system-ui, sans-serif";
    const who = r.counterparty.length > 18 ? `${r.counterparty.slice(0, 17)}…` : r.counterparty;
    ctx.fillText(`for ${who}`, 128, 80);
    ctx.fillStyle = "#9fb4c4";
    ctx.font = "14px system-ui, sans-serif";
    const when = new Date(r.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    ctx.fillText(`${r.payment ?? "free route"} · ${when}`, 128, 112);
    ctx.fillStyle = "#34d399";
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.fillText("✓ VERIFIED WORK", 128, 152);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, [r]);
  useDisposeOnChange(tex);
  const open = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    window.open(`/r/${encodeURIComponent(r.taskId)}`, "_blank", "noopener");
  };
  return (
    <group position={[x, 3.1, -5.3]}>
      {/* wooden frame */}
      <mesh>
        <boxGeometry args={[1.42, 1.12, 0.06]} />
        <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
      </mesh>
      {/* the certificate — click for the public proof page */}
      <mesh
        position={[0, 0, 0.045]}
        onClick={open}
        onPointerOver={() => (document.body.style.cursor = "pointer")}
        onPointerOut={() => (document.body.style.cursor = "auto")}
      >
        <planeGeometry args={[1.26, 0.96]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}

// A wall-mounted painted board (NOT a billboard sprite — those read huge and
// clip through walls indoors). Used for the agent status panel and the HQ sign.
function InteriorBoard({ text, title, w = 2.0, h = 0.62 }: { text: string; title?: string; w?: number; h?: number }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = Math.round((512 * h) / w);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#17222b";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "rgba(45,212,191,0.5)";
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, c.width - 12, c.height - 12);
    ctx.textAlign = "center";
    if (title) {
      ctx.fillStyle = "#2dd4bf";
      ctx.font = "bold 24px system-ui, sans-serif";
      ctx.fillText(title, c.width / 2, 42);
    }
    ctx.fillStyle = "#f0f6f4";
    ctx.font = `600 ${title ? 30 : 40}px system-ui, sans-serif`;
    let t = text;
    while (ctx.measureText(t).width > c.width - 40 && t.length > 1) t = t.slice(0, -1);
    ctx.fillText(t, c.width / 2, title ? c.height - 28 : c.height / 2 + 14);
    const tx = new THREE.CanvasTexture(c);
    tx.needsUpdate = true;
    return tx;
  }, [text, title, w, h]);
  useDisposeOnChange(tex);
  return (
    <mesh>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={tex} toneMapped={false} />
    </mesh>
  );
}

// The world map panel: a live chart of the generated town with locate buttons
// — click anything and a waypoint beam guides you there. As the town grows
// with the network, this is how a visitor finds the farm.
function MapPanel({
  buildings,
  agentByKey,
  landmarks,
  poseRef,
  extent,
  onLocate,
  onClose,
}: {
  buildings: WorldBuilding[];
  agentByKey: Map<string, WorldPlot>;
  landmarks: WorldLandmarks | null;
  poseRef: { current: PeerPose };
  extent: number;
  onLocate: (x: number, z: number, name: string) => void;
  onClose: () => void;
}) {
  // Fit the chart to the phone: never wider than the screen, never taller
  // than what the header + legend leave room for.
  const SIZE = typeof window !== "undefined"
    ? Math.max(200, Math.min(300, window.innerWidth - 40, window.innerHeight - 190))
    : 300;
  const k = SIZE / 2 / (extent * 1.06);
  const px = (wx: number) => SIZE / 2 + wx * k;
  const pz = (wz: number) => SIZE / 2 + wz * k;
  // Snapshot where you're standing when the panel opens (refs can't be read
  // mid-render) — the map is a moment-in-time chart, not a live tracker.
  const [you, setYou] = useState<{ x: number; z: number } | null>(null);
  useEffect(() => {
    setYou({ x: poseRef.current.x, z: poseRef.current.z });
  }, [poseRef]);
  // District centroids — "where do the Finance agents live?" answered with
  // one label per category instead of sixty individual names.
  const districtSpots = useMemo(() => {
    const acc = new Map<string, { x: number; z: number; n: number }>();
    for (const b of buildings) {
      const d = agentByKey.get(b.key)?.district;
      if (!d) continue;
      const cur = acc.get(d) ?? { x: 0, z: 0, n: 0 };
      acc.set(d, { x: cur.x + b.x, z: cur.z + b.z, n: cur.n + 1 });
    }
    return [...acc.entries()].map(([name, v]) => {
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
      return { name, x: v.x / v.n, z: v.z / v.n, hue: h % 360 };
    });
  }, [buildings, agentByKey]);
  const spots: { x: number; z: number; label: string; icon: string }[] = [
    { x: 0, z: 0, label: "Plaza", icon: "⭐" },
    ...(landmarks?.farm ? [{ ...landmarks.farm, label: "Farm", icon: "🌾" }] : []),
    ...(landmarks?.hof ? [{ ...landmarks.hof, label: "Hall of Fame", icon: "🏛" }] : []),
    ...(landmarks ? [{ ...landmarks.garden, label: "Garden", icon: "⛲" }] : []),
    ...(landmarks ? [{ ...landmarks.river, label: "River", icon: "🌊" }] : []),
    ...(landmarks?.ponds ?? []).map((p, i) => ({ ...p, label: `Pond ${i + 1}`, icon: "🎣" })),
  ];
  return (
    <div className={PANEL_WRAP} onClick={onClose}>
      <div className="relative rounded-2xl bg-white shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-2.5 bg-emerald-700 text-white flex items-center justify-between">
          <p className="text-sm font-bold tracking-wide">🗺 WORLD MAP — tap to travel</p>
          <button onClick={onClose} className="text-white/80 hover:text-white text-lg leading-none">×</button>
        </div>
        <div className="relative bg-[#dcead0]" style={{ width: SIZE, height: SIZE }}>
          <svg width={SIZE} height={SIZE} className="absolute inset-0">
            <circle cx={SIZE / 2} cy={SIZE / 2} r={extent * k} fill="#cfe3b4" stroke="#a8c58e" strokeWidth={2} />
            {/* the district streets, drawn exactly where they are */}
            {(landmarks?.streets ?? []).map((a, i) => (
              <line
                key={`st${i}`}
                x1={px(Math.cos(a) * 11)}
                y1={pz(Math.sin(a) * 11)}
                x2={px(Math.cos(a) * (landmarks?.extent ?? extent) * 0.85)}
                y2={pz(Math.sin(a) * (landmarks?.extent ?? extent) * 0.85)}
                stroke="#d9c9a0"
                strokeWidth={5}
                strokeLinecap="round"
              />
            ))}
            {/* the plaza */}
            <circle cx={SIZE / 2} cy={SIZE / 2} r={11 * k} fill="#d9cfc0" stroke="#c4b8a4" strokeWidth={1.5} />
            {/* the river's real arc */}
            {landmarks && (
              <polyline
                points={Array.from({ length: 25 }, (_, i) => {
                  const a = landmarks.riverArc.a0 + (i / 24) * landmarks.riverArc.span;
                  return `${px(Math.cos(a) * landmarks.riverArc.r)},${pz(Math.sin(a) * landmarks.riverArc.r)}`;
                }).join(" ")}
                fill="none"
                stroke="#7ec3d8"
                strokeWidth={7}
                strokeLinecap="round"
              />
            )}
            {(landmarks?.ponds ?? []).map((pond, i) => (
              <circle key={`pd${i}`} cx={px(pond.x)} cy={pz(pond.z)} r={6} fill="#7ec3d8" />
            ))}
            {buildings.map((b) => {
              const d = agentByKey.get(b.key)?.district ?? "";
              let h = 0;
              for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) >>> 0;
              return <circle key={b.key} cx={px(b.x)} cy={pz(b.z)} r={2.6} fill={`hsl(${h % 360} 45% 42%)`} stroke="#00000022" strokeWidth={0.5} />;
            })}
            {you && <circle cx={px(you.x)} cy={pz(you.z)} r={5} fill="#0ea5e9" stroke="#fff" strokeWidth={2} />}
          </svg>
          {spots.map((sp) => (
            <button
              key={sp.label}
              onClick={() => { onLocate(sp.x, sp.z, sp.label); onClose(); }}
              className="absolute -translate-x-1/2 -translate-y-1/2 text-base leading-none hover:scale-125 transition-transform"
              style={{ left: px(sp.x), top: pz(sp.z) }}
              title={sp.label}
            >
              {sp.icon}
            </button>
          ))}
          {districtSpots.map((d) => (
            <button
              key={`d-${d.name}`}
              onClick={() => { onLocate(d.x, d.z, `${d.name} district`); onClose(); }}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full px-1.5 py-0.5 text-[9px] font-bold text-white shadow whitespace-nowrap hover:scale-110 transition-transform"
              style={{ left: px(d.x), top: pz(d.z) - 10, backgroundColor: `hsl(${d.hue} 45% 38% / 0.92)` }}
              title={`${d.name} district`}
            >
              {d.name}
            </button>
          ))}
        </div>
        <div className="px-3 py-2 flex flex-wrap gap-1.5 bg-gray-50 max-w-[300px]">
          {spots.map((sp) => (
            <button
              key={`l-${sp.label}`}
              onClick={() => { onLocate(sp.x, sp.z, sp.label); onClose(); }}
              className="rounded-full bg-white border border-gray-200 hover:border-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-gray-700"
            >
              {sp.icon} {sp.label}
            </button>
          ))}
          {districtSpots.map((d) => (
            <button
              key={`ld-${d.name}`}
              onClick={() => { onLocate(d.x, d.z, `${d.name} district`); onClose(); }}
              className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-white"
              style={{ backgroundColor: `hsl(${d.hue} 45% 38%)` }}
            >
              {d.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// The desk terminal: what the house is FOR. A live dashboard for this agent —
// status, real stats, verified receipts (each links to its /r proof page).
function TerminalPanel({ agentId, name, plot, onClose }: { agentId: string; name: string; plot: WorldPlot | null; onClose: () => void }) {
  const [act, setAct] = useState<AgentActivity | null>(null);
  const [receipts, setReceipts] = useState<WallReceiptItem[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`/api/world/agent/${encodeURIComponent(agentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AgentActivity | null) => { if (alive && d) setAct(d); })
      .catch(() => {});
    fetch(`/api/world/agent/${encodeURIComponent(agentId)}/receipts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { receipts: WallReceiptItem[] } | null) => { if (alive && d?.receipts) setReceipts(d.receipts); })
      .catch(() => {});
    return () => { alive = false; };
  }, [agentId]);
  return (
    <div className={PANEL_WRAP} onClick={onClose}>
      <div className={`relative w-full max-w-md rounded-2xl bg-[#0d1520] border border-teal-500/30 shadow-2xl overflow-y-auto ${PANEL_MAXH} font-mono`} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
          <p className="text-teal-400 text-[11px] tracking-[0.3em]">AGENT TERMINAL</p>
          <button onClick={onClose} className="text-white/60 hover:text-white text-lg leading-none">×</button>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <p className="text-white font-bold text-lg">{name}</p>
          <p className="text-teal-300 text-xs">{act ? activityLine(act).text : "connecting…"}</p>
          {plot && (
            <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
              <div className="rounded-lg bg-white/5 py-2"><p className="text-white font-bold text-base">{plot.tasksCompleted}</p><p className="text-gray-500">tasks</p></div>
              <div className="rounded-lg bg-white/5 py-2"><p className="text-white font-bold text-base">${plot.usdcEarned.toFixed(2)}</p><p className="text-gray-500">earned</p></div>
              <div className="rounded-lg bg-white/5 py-2"><p className="text-white font-bold text-base">{plot.reputation.toFixed(1)}</p><p className="text-gray-500">rep</p></div>
            </div>
          )}
          <div>
            <p className="text-[10px] tracking-[0.25em] text-gray-500 mb-1.5">RECENT WORK — VERIFIED</p>
            {receipts.length === 0 ? (
              <p className="text-gray-500 text-xs">No completed jobs on record yet.</p>
            ) : (
              <div className="space-y-1.5 max-h-44 overflow-y-auto">
                {receipts.map((r) => (
                  <a
                    key={r.taskId}
                    href={`/r/${encodeURIComponent(r.taskId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-3 rounded-lg bg-white/5 hover:bg-teal-500/15 px-3 py-2 text-xs"
                  >
                    <span className="text-white truncate">for {r.counterparty}</span>
                    <span className="text-teal-300 shrink-0">{r.payment ?? "free"} ↗</span>
                  </a>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <a href={`/agents/${encodeURIComponent(agentId)}`} target="_blank" rel="noopener noreferrer" className="flex-1 text-center rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold py-2">Agent page ↗</a>
            <a href="/explorer" target="_blank" rel="noopener noreferrer" className="flex-1 text-center rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-bold py-2">Explorer ↗</a>
          </div>
        </div>
      </div>
    </div>
  );
}

// A little sunset-landscape painting so the frame isn't a black rectangle.
function FramedPainting() {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 176;
    const ctx = c.getContext("2d")!;
    const sky = ctx.createLinearGradient(0, 0, 0, 110);
    sky.addColorStop(0, "#ffd9a0");
    sky.addColorStop(1, "#f2a65e");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 256, 176);
    ctx.fillStyle = "#f6e27a";
    ctx.beginPath();
    ctx.arc(190, 58, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7c9a5a";
    ctx.beginPath();
    ctx.moveTo(0, 176); ctx.lineTo(0, 120);
    ctx.quadraticCurveTo(70, 86, 140, 124);
    ctx.quadraticCurveTo(200, 150, 256, 128);
    ctx.lineTo(256, 176);
    ctx.fill();
    ctx.fillStyle = "#5d7a44";
    ctx.beginPath();
    ctx.moveTo(0, 176); ctx.lineTo(0, 150);
    ctx.quadraticCurveTo(90, 120, 256, 160);
    ctx.lineTo(256, 176);
    ctx.fill();
    ctx.fillStyle = "#b0563f";
    ctx.fillRect(60, 116, 26, 18);
    ctx.beginPath();
    ctx.moveTo(54, 118); ctx.lineTo(73, 100); ctx.lineTo(92, 118);
    ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, []);
  return (
    <mesh>
      <planeGeometry args={[1.2, 0.82]} />
      <meshBasicMaterial map={tex} toneMapped={false} />
    </mesh>
  );
}

// Wave 6: inside your agent's house. An open-top room (the camera never
// fights a ceiling) with a bed, desk, fireplace and your trophy gems — and a
// live status sign for what your agent is doing right now.
function HomeInterior({ agentId, name, rarities }: { agentId: string; name: string; rarities: Rarity[] }) {
  const [status, setStatus] = useState("checking status…");
  const [wall, setWall] = useState<WallReceiptItem[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`/api/world/agent/${encodeURIComponent(agentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AgentActivity | null) => {
        if (alive && d) setStatus(activityLine(d).text);
      })
      .catch(() => { /* sign stays quiet */ });
    fetch(`/api/world/agent/${encodeURIComponent(agentId)}/receipts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { receipts: WallReceiptItem[] } | null) => {
        if (alive && d?.receipts) setWall(d.receipts.slice(0, 4));
      })
      .catch(() => { /* bare wall */ });
    return () => { alive = false; };
  }, [agentId]);
  const fire = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (fire.current) {
      const f = 0.9 + Math.sin(state.clock.elapsedTime * 9) * 0.12 + Math.sin(state.clock.elapsedTime * 23) * 0.05;
      fire.current.scale.set(f, f * (1 + Math.sin(state.clock.elapsedTime * 13) * 0.1), f);
    }
  });
  const W = 11;
  return (
    <group position={[INTERIOR_POS.x, 0, INTERIOR_POS.z]}>
      {/* plank floor */}
      {Array.from({ length: 8 }, (_, i) => (
        <mesh key={`f${i}`} position={[-W / 2 + ((i + 0.5) * W) / 8, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[W / 8 - 0.06, W + 1.4]} />
          <meshStandardMaterial color={i % 2 ? "#9a7648" : "#8f6c40"} roughness={0.9} />
        </mesh>
      ))}
      {/* walls: N, E, W solid; S has the doorway */}
      <mesh position={[0, 2.5, -W / 2]}>
        <boxGeometry args={[W, 5, 0.3]} />
        <meshStandardMaterial color="#e3d5b8" roughness={0.95} />
      </mesh>
      <mesh position={[-W / 2, 2.5, 0]}>
        <boxGeometry args={[0.3, 5, W + 1.4]} />
        <meshStandardMaterial color="#dccdb0" roughness={0.95} />
      </mesh>
      <mesh position={[W / 2, 2.5, 0]}>
        <boxGeometry args={[0.3, 5, W + 1.4]} />
        <meshStandardMaterial color="#dccdb0" roughness={0.95} />
      </mesh>
      {/* south wall with a REAL door: solid segments + header, not a void gap */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (0.95 + 2.275), 2.5, W / 2 + 0.7]}>
          <boxGeometry args={[4.55, 5, 0.3]} />
          <meshStandardMaterial color="#e3d5b8" roughness={0.95} />
        </mesh>
      ))}
      <mesh position={[0, 3.75, W / 2 + 0.7]}>
        <boxGeometry args={[1.9, 2.5, 0.3]} />
        <meshStandardMaterial color="#e3d5b8" roughness={0.95} />
      </mesh>
      {/* door frame + the door itself (E at the mat steps you outside) */}
      <mesh position={[0, 2.42, W / 2 + 0.7]}>
        <boxGeometry args={[2.0, 0.16, 0.36]} />
        <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={`j${side}`} position={[side * 0.93, 1.25, W / 2 + 0.7]}>
          <boxGeometry args={[0.14, 2.5, 0.36]} />
          <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
        </mesh>
      ))}
      <mesh position={[0, 1.22, W / 2 + 0.72]}>
        <boxGeometry args={[1.72, 2.4, 0.1]} />
        <meshStandardMaterial color="#7a4a24" roughness={0.9} />
      </mesh>
      <mesh position={[0.6, 1.2, W / 2 + 0.64]}>
        <sphereGeometry args={[0.06, 8, 8]} />
        <meshStandardMaterial color="#d9b45a" metalness={0.4} roughness={0.5} />
      </mesh>
      {/* ceiling: closed plane + beams + a hanging lamp — the room is FP-only,
          so nothing ever needs to see in from above */}
      <mesh position={[0, 5.0, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[W, W + 1.4]} />
        <meshStandardMaterial color="#d9cba9" roughness={0.95} />
      </mesh>
      {[-3, 0, 3].map((bx) => (
        <mesh key={bx} position={[bx, 4.85, 0]}>
          <boxGeometry args={[0.24, 0.3, W + 1.4]} />
          <meshStandardMaterial color="#8a6240" roughness={0.9} />
        </mesh>
      ))}
      <group position={[0, 0, 0.6]}>
        <mesh position={[0, 4.55, 0]}>
          <cylinderGeometry args={[0.02, 0.02, 0.9, 4]} />
          <meshStandardMaterial color="#3a3a44" roughness={0.8} />
        </mesh>
        <mesh position={[0, 4.02, 0]}>
          <coneGeometry args={[0.42, 0.36, 10, 1, true]} />
          <meshStandardMaterial color="#2f4a44" roughness={0.7} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, 3.94, 0]}>
          <sphereGeometry args={[0.11, 8, 8]} />
          <meshStandardMaterial color="#ffe8b8" emissive="#ffcf7a" emissiveIntensity={1.4} toneMapped={false} />
        </mesh>
      </group>
      {/* framed window on the north wall — glass, mullions, sill */}
      <group position={[2.2, 2.4, -W / 2 + 0.17]}>
        <mesh>
          <boxGeometry args={[1.6, 1.6, 0.08]} />
          <meshStandardMaterial color="#bcd9ef" emissive="#8fbce8" emissiveIntensity={0.35} roughness={0.3} />
        </mesh>
        {/* frame */}
        {[[-0.84, 0, 0.1, 1.84], [0.84, 0, 0.1, 1.84]].map(([fx, fy, fw, fh], i) => (
          <mesh key={`v${i}`} position={[fx, fy, 0.02]}>
            <boxGeometry args={[fw, fh, 0.14]} />
            <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
          </mesh>
        ))}
        {[[-0.87], [0.87]].map(([fy], i) => (
          <mesh key={`h${i}`} position={[0, fy, 0.02]}>
            <boxGeometry args={[1.78, 0.1, 0.14]} />
            <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
          </mesh>
        ))}
        {/* mullion cross */}
        <mesh position={[0, 0, 0.05]}>
          <boxGeometry args={[0.06, 1.6, 0.05]} />
          <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
        </mesh>
        <mesh position={[0, 0, 0.05]}>
          <boxGeometry args={[1.6, 0.06, 0.05]} />
          <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
        </mesh>
        {/* sill */}
        <mesh position={[0, -0.98, 0.08]}>
          <boxGeometry args={[1.9, 0.08, 0.24]} />
          <meshStandardMaterial color="#7a5a38" roughness={0.85} />
        </mesh>
      </group>
      {/* baseboards ground the walls */}
      <mesh position={[0, 0.16, -W / 2 + 0.18]}>
        <boxGeometry args={[W - 0.3, 0.32, 0.06]} />
        <meshStandardMaterial color="#c9b795" roughness={0.95} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (W / 2 - 0.18), 0.16, 0]}>
          <boxGeometry args={[0.06, 0.32, W + 1.0]} />
          <meshStandardMaterial color="#c9b795" roughness={0.95} />
        </mesh>
      ))}
      {/* layered rug */}
      <mesh position={[0, 0.02, 0.6]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[2.2, 24]} />
        <meshStandardMaterial color="#a85f4a" roughness={1} />
      </mesh>
      <mesh position={[0, 0.028, 0.6]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.45, 24]} />
        <meshStandardMaterial color="#c07a5e" roughness={1} />
      </mesh>
      {/* bed — platform, headboard, mattress, blanket (deliberately wider than
          the mattress: shared side planes were z-fighting green/white) */}
      <group position={[-3.6, 0, -3.6]}>
        <mesh position={[0, 0.35, 0]} castShadow>
          <boxGeometry args={[2.2, 0.5, 3.2]} />
          <meshStandardMaterial color="#7a5a38" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.95, -1.52]}>
          <boxGeometry args={[2.3, 0.95, 0.16]} />
          <meshStandardMaterial color="#66492e" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.68, 0.15]}>
          <boxGeometry args={[2.0, 0.22, 2.75]} />
          <meshStandardMaterial color="#e8e2d2" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.87, -1.05]}>
          <boxGeometry args={[1.45, 0.2, 0.55]} />
          <meshStandardMaterial color="#f4f1e8" roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.8, 0.62]}>
          <boxGeometry args={[2.08, 0.16, 1.72]} />
          <meshStandardMaterial color="#5b8a8a" roughness={0.9} />
        </mesh>
        {/* folded edge */}
        <mesh position={[0, 0.815, -0.22]}>
          <boxGeometry args={[2.08, 0.15, 0.24]} />
          <meshStandardMaterial color="#4d7676" roughness={0.9} />
        </mesh>
      </group>
      {/* bedside table + reading lamp */}
      <group position={[-1.9, 0, -4.85]}>
        <mesh position={[0, 0.3, 0]} castShadow>
          <boxGeometry args={[0.68, 0.6, 0.6]} />
          <meshStandardMaterial color="#7a5a38" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.72, 0]}>
          <cylinderGeometry args={[0.045, 0.06, 0.24, 6]} />
          <meshStandardMaterial color="#4a4038" roughness={0.8} />
        </mesh>
        <mesh position={[0, 0.92, 0]}>
          <coneGeometry args={[0.17, 0.2, 8, 1, true]} />
          <meshStandardMaterial color="#f2d8a0" emissive="#e8b968" emissiveIntensity={0.55} roughness={0.7} side={THREE.DoubleSide} />
        </mesh>
      </group>
      {/* fireplace on the east wall */}
      <group position={[W / 2 - 0.8, 0, 1.6]} rotation={[0, -Math.PI / 2, 0]}>
        <mesh position={[0, 1.1, 0]} castShadow>
          <boxGeometry args={[2.2, 2.2, 0.9]} />
          <meshStandardMaterial color="#8a8378" roughness={1} />
        </mesh>
        <mesh position={[0, 0.7, 0.32]}>
          <boxGeometry args={[1.3, 1.1, 0.4]} />
          <meshStandardMaterial color="#241a12" />
        </mesh>
        <mesh ref={fire} position={[0, 0.5, 0.4]}>
          <coneGeometry args={[0.32, 0.7, 6]} />
          <meshStandardMaterial color="#ffb14a" emissive="#ff8a2a" emissiveIntensity={1.6} toneMapped={false} />
        </mesh>
        <pointLight position={[0, 1, 0.9]} color="#ffb36a" intensity={5} distance={9} decay={2} />
      </group>
      {/* the agent's workstation against the north wall: desk, monitor on a
          stand, keyboard, mug, chair — the screen faces into the room */}
      <group position={[3.7, 0, -4.55]}>
        <mesh position={[0, 0.78, 0]} castShadow>
          <boxGeometry args={[2.4, 0.1, 1.1]} />
          <meshStandardMaterial color="#7a5a38" roughness={0.9} />
        </mesh>
        {[-1, 1].map((sx) => (
          <mesh key={sx} position={[sx * 1.05, 0.38, 0]}>
            <boxGeometry args={[0.12, 0.76, 0.9]} />
            <meshStandardMaterial color="#66492e" roughness={0.95} />
          </mesh>
        ))}
        {/* monitor: base → neck → screen with glowing panel inset */}
        <mesh position={[0, 0.86, -0.15]}>
          <boxGeometry args={[0.5, 0.05, 0.3]} />
          <meshStandardMaterial color="#2b2b33" roughness={0.6} />
        </mesh>
        <mesh position={[0, 1.02, -0.18]}>
          <boxGeometry args={[0.09, 0.3, 0.07]} />
          <meshStandardMaterial color="#2b2b33" roughness={0.6} />
        </mesh>
        <group position={[0, 1.52, -0.16]} rotation={[-0.08, 0, 0]}>
          <mesh>
            <boxGeometry args={[1.5, 0.9, 0.07]} />
            <meshStandardMaterial color="#1c1c24" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0, 0.045]}>
            <planeGeometry args={[1.38, 0.78]} />
            <meshStandardMaterial color="#0f1b26" emissive="#2dd4bf" emissiveIntensity={0.55} roughness={0.4} />
          </mesh>
        </group>
        <mesh position={[0.05, 0.855, 0.22]} rotation={[0, 0.06, 0]}>
          <boxGeometry args={[0.8, 0.05, 0.28]} />
          <meshStandardMaterial color="#3a3a44" roughness={0.7} />
        </mesh>
        <mesh position={[0.85, 0.9, 0.18]}>
          <cylinderGeometry args={[0.07, 0.06, 0.14, 8]} />
          <meshStandardMaterial color="#c05f4a" roughness={0.8} />
        </mesh>
        {/* chair with backrest, pulled up to the desk */}
        <group position={[0, 0, 1.05]}>
          <mesh position={[0, 0.44, 0]} castShadow>
            <boxGeometry args={[0.66, 0.1, 0.62]} />
            <meshStandardMaterial color="#8a6240" roughness={0.9} />
          </mesh>
          {[[-0.26, -0.24], [0.26, -0.24], [-0.26, 0.24], [0.26, 0.24]].map(([lx, lz], i) => (
            <mesh key={i} position={[lx, 0.2, lz]}>
              <boxGeometry args={[0.08, 0.4, 0.08]} />
              <meshStandardMaterial color="#66492e" roughness={0.95} />
            </mesh>
          ))}
          <mesh position={[0, 0.82, 0.29]}>
            <boxGeometry args={[0.66, 0.66, 0.08]} />
            <meshStandardMaterial color="#8a6240" roughness={0.9} />
          </mesh>
        </group>
      </group>
      {/* live agent status — a mounted panel on the wall above the desk */}
      <group position={[4.35, 2.62, -W / 2 + 0.19]}>
        <mesh position={[0, 0, -0.02]}>
          <boxGeometry args={[2.14, 0.76, 0.06]} />
          <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
        </mesh>
        <InteriorBoard title="AGENT STATUS" text={status} />
      </group>
      {/* trophy gems on a stand by the west wall */}
      <group position={[-W / 2 + 1.0, 0, 2.6]}>
        <mesh position={[0, 0.6, 0]} castShadow>
          <boxGeometry args={[1.3, 0.09, 0.48]} />
          <meshStandardMaterial color="#7a5a38" roughness={0.9} />
        </mesh>
        {[-0.52, 0.52].map((x) => (
          <mesh key={x} position={[x, 0.3, 0]}>
            <boxGeometry args={[0.09, 0.6, 0.38]} />
            <meshStandardMaterial color="#66492e" roughness={0.95} />
          </mesh>
        ))}
        {rarities.slice(0, 4).map((r, i) => (
          <mesh key={i} position={[-0.45 + i * 0.3, 0.78, 0]} castShadow>
            <icosahedronGeometry args={[0.1, 0]} />
            <meshStandardMaterial color={RARITY_COLOR[r]} emissive={RARITY_COLOR[r]} emissiveIntensity={0.45} roughness={0.3} />
          </mesh>
        ))}
      </group>
      {/* the receipts wall — recent completed work, framed; click → /r proof page */}
      {wall.map((r, i) => (
        <ReceiptFrame key={r.taskId} r={r} x={-3.9 + i * 1.47} />
      ))}
      {wall.length === 0 && (
        <group position={[-1.7, 3.1, -5.3]}>
          <mesh position={[0, 0, -0.02]}>
            <boxGeometry args={[3.7, 0.9, 0.06]} />
            <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
          </mesh>
          <InteriorBoard title="RECEIPTS WALL" text="No completed jobs yet — the proof hangs here" w={3.5} h={0.78} />
        </group>
      )}
      {/* doormat at the exit gap */}
      <mesh position={[0, 0.03, W / 2 + 0.2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.6, 0.9]} />
        <meshStandardMaterial color="#a8906a" roughness={1} />
      </mesh>
      {/* the house name mounted on the door header, facing back in */}
      <group position={[0, 3.9, W / 2 + 0.5]} rotation={[0, Math.PI, 0]}>
        <mesh position={[0, 0, -0.02]}>
          <boxGeometry args={[2.74, 0.76, 0.06]} />
          <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
        </mesh>
        <InteriorBoard text={`${name} HQ`} w={2.6} h={0.62} />
      </group>
      {/* bookshelf on the west wall */}
      <group position={[-5.1, 0, 0.9]}>
        <mesh position={[0.04, 1.3, 0]}>
          <boxGeometry args={[0.1, 2.6, 1.9]} />
          <meshStandardMaterial color="#66492e" roughness={0.95} />
        </mesh>
        {[-0.9, 0.95].map((sz) => (
          <mesh key={sz} position={[0.3, 1.3, sz]}>
            <boxGeometry args={[0.52, 2.6, 0.08]} />
            <meshStandardMaterial color="#6b4d2e" roughness={0.9} />
          </mesh>
        ))}
        {[0.6, 1.3, 2.0].map((sy) => (
          <mesh key={sy} position={[0.3, sy, 0]}>
            <boxGeometry args={[0.5, 0.06, 1.82]} />
            <meshStandardMaterial color="#7a5a38" roughness={0.9} />
          </mesh>
        ))}
        {/* books — mixed spines per shelf */}
        {[0.63, 1.33, 2.03].flatMap((sy, si) =>
          ["#b0563f", "#3e7cb1", "#7a9a3f", "#b08b3e", "#7a5aa0", "#4d7676"].slice(0, 4 + (si % 3)).map((col, bi) => (
            <mesh key={`${si}-${bi}`} position={[0.3, sy + 0.19, -0.7 + bi * 0.28 + si * 0.05]}>
              <boxGeometry args={[0.3, 0.38 - (bi % 3) * 0.04, 0.16]} />
              <meshStandardMaterial color={col} roughness={0.85} />
            </mesh>
          )),
        )}
      </group>
      {/* potted plant in the south-east corner */}
      <group position={[4.6, 0, 4.4]}>
        <mesh position={[0, 0.22, 0]} castShadow>
          <cylinderGeometry args={[0.24, 0.3, 0.44, 8]} />
          <meshStandardMaterial color="#a0623c" roughness={0.9} />
        </mesh>
        {[[0, 0.72, 0, 0.3], [-0.16, 0.58, 0.1, 0.2], [0.15, 0.6, -0.09, 0.22]].map(([lx, ly, lz, r], i) => (
          <mesh key={i} position={[lx, ly, lz]}>
            <sphereGeometry args={[r, 7, 6]} />
            <meshStandardMaterial color="#3f7a42" roughness={0.95} />
          </mesh>
        ))}
      </group>
      {/* a framed print on the east wall, north of the fireplace */}
      <group position={[W / 2 - 0.19, 2.5, -1.4]} rotation={[0, -Math.PI / 2, 0]}>
        <mesh position={[0, 0, -0.02]}>
          <boxGeometry args={[1.34, 0.96, 0.06]} />
          <meshStandardMaterial color="#6b4d2e" roughness={0.85} />
        </mesh>
        <FramedPainting />
      </group>
      {/* warm fill — the room is fully enclosed now, so these carry the light */}
      <pointLight position={[0, 3.7, 0.6]} color="#ffe2b0" intensity={20} distance={16} decay={2} />
      <pointLight position={[-3.2, 2.6, -3.2]} color="#ffd9a0" intensity={6} distance={9} decay={2} />
    </group>
  );
}

// The network, visible: whenever a task completes anywhere on Axon, a light
// streaks from the requester's house to the worker's house and bursts on
// arrival. The town glittering IS live traffic — none of it is decoration.
const STREAK_SLOTS = 8;
interface StreakSlot {
  live: boolean;
  delay: number;
  t: number;
  dur: number;
  x0: number; z0: number; x1: number; z1: number;
  apex: number;
  burst: number;
}

function TaskStreaks({ buildings }: { buildings: WorldBuilding[] }) {
  const posRef = useRef(new Map<string, { x: number; z: number }>());
  useEffect(() => {
    const m = new Map<string, { x: number; z: number }>();
    for (const b of buildings) m.set(b.key, { x: b.x, z: b.z });
    posRef.current = m;
  }, [buildings]);

  const glowTex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, "rgba(140,255,235,0.9)");
    g.addColorStop(0.5, "rgba(45,212,191,0.35)");
    g.addColorStop(1, "rgba(45,212,191,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, []);

  const slots = useRef<StreakSlot[]>(
    Array.from({ length: STREAK_SLOTS }, () => ({ live: false, delay: 0, t: 0, dur: 2, x0: 0, z0: 0, x1: 0, z1: 0, apex: 8, burst: 0 })),
  );
  const queue = useRef<{ x0: number; z0: number; x1: number; z1: number; delay: number }[]>([]);
  const seen = useRef(new Set<string>());
  const groups = useRef<(THREE.Group | null)[]>([]);

  useEffect(() => {
    let alive = true;
    let first = true;
    const poll = () => {
      fetch("/api/world/activity")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { events: { taskId: string; fromAgent: string; toAgent: string }[] } | null) => {
          if (!alive || !d?.events) return;
          // Until the town layout has arrived we can't place anything — try again
          // next poll without consuming the events.
          if (posRef.current.size === 0) return;
          // On the very first poll, replay just a taste of the recent past so the
          // town is alive the moment you walk in; after that, only new completions.
          const events = first ? d.events.slice(0, 6) : d.events;
          if (first) for (const ev of d.events) seen.current.add(ev.taskId);
          let stagger = 0;
          for (const ev of events) {
            if (!first && seen.current.has(ev.taskId)) continue;
            const to = posRef.current.get(ev.toAgent);
            // Don't mark seen until we can actually place it — the worker's
            // house may not have loaded on this poll; let a later poll retry.
            if (!to) continue;
            if (queue.current.length > 24) break;
            seen.current.add(ev.taskId);
            // Requesters without a house (users, external callers) send from the plaza.
            const from = posRef.current.get(ev.fromAgent) ?? { x: 0, z: 0 };
            queue.current.push({ x0: from.x, z0: from.z, x1: to.x, z1: to.z, delay: stagger });
            stagger += 0.5 + Math.random() * 0.7;
          }
          first = false;
          if (seen.current.size > 800) seen.current = new Set(d.events.map((e) => e.taskId));
        })
        .catch(() => { /* the town just doesn't sparkle this round */ });
    };
    poll();
    const iv = setInterval(poll, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    for (let i = 0; i < STREAK_SLOTS; i++) {
      const s = slots.current[i];
      const grp = groups.current[i];
      if (!grp) continue;
      if (!s.live) {
        const next = queue.current.shift();
        if (!next) {
          grp.visible = false;
          continue;
        }
        s.live = true;
        s.delay = next.delay;
        s.t = 0;
        s.burst = 0;
        s.x0 = next.x0; s.z0 = next.z0; s.x1 = next.x1; s.z1 = next.z1;
        const dist = Math.hypot(next.x1 - next.x0, next.z1 - next.z0);
        s.dur = Math.min(3.0, 1.1 + dist / 55);
        s.apex = 6 + dist * 0.1;
      }
      if (s.delay > 0) {
        s.delay -= dt;
        grp.visible = false;
        continue;
      }
      grp.visible = true;
      const [head, glow, t0, t1, t2, burst] = grp.children as [THREE.Mesh, THREE.Sprite, THREE.Mesh, THREE.Mesh, THREE.Mesh, THREE.Mesh];
      const at = (tt: number): [number, number, number] => {
        const t = Math.max(0, Math.min(1, tt));
        const x = s.x0 + (s.x1 - s.x0) * t;
        const z = s.z0 + (s.z1 - s.z0) * t;
        const y = 2.4 + (s.apex - 2.4) * 4 * t * (1 - t);
        return [x, y, z];
      };
      if (s.t < 1) {
        s.t = Math.min(1, s.t + dt / s.dur);
        head.visible = glow.visible = true;
        burst.visible = false;
        head.position.set(...at(s.t));
        glow.position.copy(head.position);
        const trail = [t0, t1, t2];
        trail.forEach((tm, j) => {
          const tt = s.t - 0.05 * (j + 1);
          tm.visible = tt > 0;
          if (tt > 0) tm.position.set(...at(tt));
        });
      } else {
        head.visible = glow.visible = t0.visible = t1.visible = t2.visible = false;
        s.burst = Math.min(1, s.burst + dt / 0.55);
        burst.visible = true;
        burst.position.set(s.x1, 2.6, s.z1);
        const sc = 0.6 + s.burst * 5;
        burst.scale.set(sc, sc, sc);
        (burst.material as THREE.MeshBasicMaterial).opacity = (1 - s.burst) * 0.85;
        if (s.burst >= 1) s.live = false;
      }
    }
  });

  return (
    <group name="streaks">
      {Array.from({ length: STREAK_SLOTS }, (_, i) => (
        <group key={i} ref={(el) => { groups.current[i] = el; }} visible={false}>
          <mesh>
            <sphereGeometry args={[0.24, 10, 10]} />
            <meshBasicMaterial color="#a7fff0" toneMapped={false} />
          </mesh>
          <sprite scale={[2.2, 2.2, 1]}>
            <spriteMaterial map={glowTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
          </sprite>
          {[0.55, 0.34, 0.18].map((op, j) => (
            <mesh key={j}>
              <sphereGeometry args={[0.16 - j * 0.04, 8, 8]} />
              <meshBasicMaterial color="#2dd4bf" transparent opacity={op} toneMapped={false} depthWrite={false} />
            </mesh>
          ))}
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.5, 0.72, 24]} />
            <meshBasicMaterial color="#7ff5e4" transparent opacity={0.9} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// A guiding light: when a panel names an agent, this beam marks their house
// across the map until you reach it. Answers "okay, but WHERE is that?"
function WaypointBeacon({ x, z, poseRef, onArrive }: { x: number; z: number; poseRef: { current: PeerPose }; onArrive: () => void }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (ring.current) {
      const pulse = 1 + Math.sin(state.clock.elapsedTime * 3.2) * 0.18;
      ring.current.scale.set(pulse, pulse, 1);
    }
    const p = poseRef.current;
    if (Math.hypot(p.x - x, p.z - z) < 6) onArrive();
  });
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 30, 0]}>
        <cylinderGeometry args={[0.5, 0.9, 60, 10, 1, true]} />
        <meshBasicMaterial color="#2dd4bf" transparent opacity={0.32} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={ring} position={[0, 0.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.6, 2.1, 32]} />
        <meshBasicMaterial color="#2dd4bf" transparent opacity={0.75} toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

// Watches for another player standing close enough to hand an item to —
// the inventory grows a Gift button while someone is beside you.
function NearPeerManager({
  posesRef,
  poseRef,
  peersRef,
  onNear,
}: {
  posesRef: React.RefObject<Map<string, PeerPose>>;
  poseRef: { current: PeerPose };
  peersRef: React.RefObject<PeerMeta[]>;
  onNear: (p: { id: string; name: string } | null) => void;
}) {
  const shown = useRef<string | null>(null);
  useFrame(() => {
    const me = poseRef.current;
    let best: string | null = null;
    let bestD = 4;
    for (const [pid, pose] of posesRef.current ?? []) {
      const d = Math.hypot(me.x - pose.x, me.z - pose.z);
      if (d < bestD) { bestD = d; best = pid; }
    }
    if (best !== shown.current) {
      shown.current = best;
      const meta2 = best ? peersRef.current?.find((q) => q.id === best) : undefined;
      onNear(best && meta2 ? { id: best, name: meta2.name } : null);
    }
  });
  return null;
}

// A ticking mm:ss.d readout for the Ring Run HUD.
function RingTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  return <span>{(Math.max(0, now - startedAt) / 1000).toFixed(1)}s</span>;
}

// The inventory panel — everything won from the world's minigames, grouped and
// colour-coded by rarity. Guests hold items for the session only.
function InventoryPanel({ inv, wallet, giftTo, onGift, onClose, onEat }: { inv: Record<string, number>; wallet: string | null; giftTo: { id: string; name: string } | null; onGift: (id: string) => void; onClose: () => void; onEat: (id: string) => void }) {
  const entries = Object.entries(inv)
    .filter(([id, n]) => n > 0 && ITEMS[id])
    .sort((a, b) => {
      const ra = RARITY_ORDER.indexOf(ITEMS[a[0]].rarity);
      const rb = RARITY_ORDER.indexOf(ITEMS[b[0]].rarity);
      return ra !== rb ? ra - rb : ITEMS[a[0]].name.localeCompare(ITEMS[b[0]].name);
    });
  const total = entries.reduce((s, [, n]) => s + n, 0);
  return (
    <div className={`absolute top-16 right-4 rounded-2xl bg-white/95 backdrop-blur shadow-2xl overflow-hidden z-40 ${IS_TOUCH ? "w-64 max-h-[55vh] overflow-y-auto" : "w-80"}`}>
      <div className="px-4 py-3 bg-teal-600 text-white flex items-center justify-between">
        <p className="text-sm font-bold tracking-wide">🎒 INVENTORY {total > 0 && <span className="font-mono font-normal">· {total}</span>}</p>
        <button onClick={onClose} className="text-white/80 hover:text-white text-lg leading-none">×</button>
      </div>
      <div className="p-3 max-h-80 overflow-auto">
        {entries.length === 0 ? (
          <p className="text-sm text-gray-500 px-1 py-3 text-center">
            Nothing yet — fish at a pond 🎣, chase the golden hen 🐔, or beat the Ring Run 🏁.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {entries.map(([id, n]) => {
              const d = ITEMS[id];
              return (
                <li key={id} className="rounded-lg border-2 bg-white px-2.5 py-2" style={{ borderColor: RARITY_COLOR[d.rarity] }}>
                  <div className="flex items-center justify-between">
                    <ItemIcon id={id} size={24} />
                    <span className="text-xs font-mono text-gray-500">×{n}</span>
                  </div>
                  <p className="text-xs font-bold text-gray-800 mt-1 truncate">{d.name}</p>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-semibold" style={{ color: RARITY_COLOR[d.rarity] }}>{RARITY_LABEL[d.rarity]}</p>
                    {d.food && (
                      <button
                        onClick={() => onEat(id)}
                        className="text-[10px] font-bold rounded-full bg-lime-600 text-white px-2 py-0.5 hover:bg-lime-500"
                      >
                        Eat
                      </button>
                    )}
                    {giftTo && (
                      <button
                        onClick={() => onGift(id)}
                        className="text-[10px] font-bold rounded-full bg-indigo-600 text-white px-2 py-0.5 hover:bg-indigo-500"
                      >
                        Gift
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="px-4 py-2 border-t border-gray-200 bg-gray-50">
        <p className="text-[11px] text-gray-500">
          {giftTo ? `Standing beside ${giftTo.name} — gift them something!` : wallet ? "Saved to your wallet — items stay when you leave." : "Guest inventory — connect a wallet to keep items after you leave."}
        </p>
      </div>
    </div>
  );
}

// Live agent data for a plot (subset of the /api/world snapshot we render).
interface WorldPlot {
  agentId: string;
  name: string;
  district: string;
  x: number;
  z: number;
  size: number;
  reputation: number;
  active: boolean;
  tasksCompleted: number;
  usdcEarned: number;
  verified: boolean;
  walletAddress: string | null;
}
interface WeeklyTopAgent {
  agentId: string;
  name: string;
  price: string | null;
  tasks7d: number;
}
interface WorldSnapshot {
  totals: { agents: number; districts: number; activeAgents: number };
  plots: WorldPlot[];
  districts: OpenDistrict[];
  edges: [string, string][];
  weeklyTop?: WeeklyTopAgent[];
}

interface EpochStanding {
  agentId: string;
  name: string;
  score: number;
  tasks: number;
  usdc: number;
  rank: number;
}
interface EpochSnapshot {
  index: number;
  startsAt: string;
  endsAt: string;
  msRemaining: number;
  totals: { tasks: number; usdc: number; agents: number };
  leaderboard: EpochStanding[];
}

function Player({
  solids,
  buildings,
  benches,
  animalsRef,
  boostRef,
  bouncePads,
  bounceFxRef,
  fishingSpot,
  onFishMove,
  onNearest,
  onInteract,
  onNearBench,
  onSitting,
  spawnTo,
  interior = false,
  restRef,
  onRestEnd,
  perfTier = 0,
  touchRef,
  look,
  firstPerson,
  name,
  poseRef,
  peersRef,
  bubblesRef,
  selfId,
  aerial,
  worldRadius,
  lowPower,
}: {
  solids: Collider[];
  buildings: WorldBuilding[];
  benches: BenchSpot[];
  animalsRef?: React.RefObject<{ x: number; z: number }[]>;
  boostRef?: React.RefObject<number>;
  bouncePads: { x: number; z: number; r: number }[];
  bounceFxRef?: React.RefObject<{ x: number; z: number; t: number } | null>;
  fishingSpot: FishSpot | null;
  onFishMove: () => void;
  onNearest: (key: string | null) => void;
  onInteract: (key: string) => void;
  onNearBench: (near: boolean) => void;
  onSitting: (sitting: boolean) => void;
  spawnTo?: [number, number] | null;
  /** Inside a house: room-box clamping replaces world solids + boundary. */
  interior?: boolean;
  /** Lying in the interior bed — locked flat until a movement key. */
  restRef?: { current: boolean };
  onRestEnd?: () => void;
  /** Adaptive quality tier from the governor — lowers render scale. */
  perfTier?: number;
  /** Virtual joystick state (mobile): x/y in -1..1, run at the rim. */
  touchRef?: { current: { mx: number; my: number; run: boolean } };
  look: AvatarLook;
  firstPerson: boolean;
  name: string;
  poseRef: { current: PeerPose };
  peersRef?: React.RefObject<Map<string, PeerPose>>;
  bubblesRef: React.RefObject<Map<string, Bubble>>;
  selfId: string | null;
  aerial: boolean;
  worldRadius: number;
  lowPower: boolean;
}) {
  const ref = useRef<THREE.Group>(null);
  const pos = useRef(new THREE.Vector3(0, 0, 18)); // start on the plaza's south path
  const facing = useRef(Math.PI);
  const camYaw = useRef(0);
  const keys = useRef<Record<string, boolean>>({});
  const target = useRef(new THREE.Vector3());
  const lookAt = useRef(new THREE.Vector3());
  const nearest = useRef<string | null>(null);
  const gait = useRef<Gait>({ speed: 0 });
  const jumpH = useRef(0); // height above ground during a jump
  const jumpV = useRef(0); // vertical velocity
  const grounded = useRef(true);
  const buildingsRef = useRef(buildings);
  useEffect(() => { buildingsRef.current = buildings; }, [buildings]);
  const benchesRef = useRef(benches);
  useEffect(() => { benchesRef.current = benches; }, [benches]);
  const padsRef = useRef(bouncePads);
  useEffect(() => { padsRef.current = bouncePads; }, [bouncePads]);
  const sitRef = useRef<BenchSpot | null>(null);
  const nearBenchRef = useRef<BenchSpot | null>(null);
  const fishRef = useRef<FishSpot | null>(fishingSpot);
  useEffect(() => { fishRef.current = fishingSpot; }, [fishingSpot]);
  const fpRef = useRef(firstPerson);
  useEffect(() => { fpRef.current = firstPerson; }, [firstPerson]);
  const interiorRef = useRef(interior);
  useEffect(() => { interiorRef.current = interior; }, [interior]);
  const aerialRef = useRef(aerial);
  useEffect(() => { aerialRef.current = aerial; }, [aerial]);
  const avatarWrap = useRef<THREE.Group>(null);
  const stepClock = useRef(0);
  const lastYawRef = useRef(0);
  const { camera, gl } = useThree();
  const setDpr = useThree((s) => s.setDpr);

  // Perf: the shadow map NEVER auto-renders every frame. In the walkable world
  // it refreshes on a throttle (every 3rd frame — the sun is static, so only
  // moving animals/clouds need it); in the aerial overview it's frozen solid.
  // Combined with a lower pixel ratio this is what keeps walking + dragging smooth.
  const frame = useRef(0);
  useEffect(() => {
    /* eslint-disable react-hooks/immutability */
    if (aerial) {
      setDpr(1);
      gl.shadowMap.autoUpdate = false;
      // Sky view puts the camera hundreds of units up: with near=0.1 the depth
      // buffer can't separate the layered roads/pond water during the flight
      // and they shimmer. A far view doesn't need a close near plane.
      camera.near = 6;
      camera.updateProjectionMatrix();
    } else {
      setDpr(perfTier >= 2 ? 0.85 : perfTier >= 1 || lowPower ? 1 : firstPerson ? 1.0 : 1.1);
      gl.shadowMap.autoUpdate = false;
      gl.shadowMap.needsUpdate = true;
      camera.near = 0.25;
      camera.updateProjectionMatrix();
    }
    /* eslint-enable react-hooks/immutability */
  }, [aerial, lowPower, firstPerson, perfTier, gl, setDpr, camera]);

  // Teleport to "your district" when a wallet resolves to owned agents.
  useEffect(() => {
    if (spawnTo) {
      pos.current.set(spawnTo[0], 0, spawnTo[1]);
      facing.current = Math.atan2(-spawnTo[0], -spawnTo[1]); // face the plaza
      // Snap the camera with the teleport — lerping from the old spot reads
      // as a camera flight across the whole map.
      camSnap.current = true;
      // A teleport breaks any seat/fishing lock — otherwise the lock keeps
      // snapping the player back to the old spot every frame.
      if (sitRef.current) {
        sitRef.current = null;
        onSitting(false);
      }
    }
  }, [spawnTo, onSitting]);

  // Movement keys (Space is swallowed so the page doesn't scroll)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping()) return;
      keys.current[e.code] = true;
      if (e.code === "Space") e.preventDefault();
    };
    const up = (e: KeyboardEvent) => { keys.current[e.code] = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Interact key (edge-triggered): stand up ▸ sit down ▸ open the nearest agent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping()) return;
      if (e.code !== "KeyE") return;
      // While fishing, resting, or inside a house, E belongs to that context
      // (FishingManager / the interior's own handlers). Firing onInteract here
      // would pop a house card over the fishing HUD, since `nearest` freezes at
      // the last building when the per-frame recompute is skipped mid-lock.
      if (fishRef.current || restRef?.current || interiorRef.current) return;
      if (sitRef.current) {
        sitRef.current = null;
        onSitting(false);
        return;
      }
      if (nearBenchRef.current) {
        sitRef.current = nearBenchRef.current;
        onSitting(true);
        return;
      }
      if (nearest.current) onInteract(nearest.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onInteract, onSitting, restRef]);

  // Scroll wheel zoom — a little further out, or close enough to admire your
  // own outfit, never beyond either end.
  const camDist = useRef(CAM_DIST);
  const camSnap = useRef(false); // set on teleport: place the camera, don't fly it
  useEffect(() => {
    const el = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camDist.current = Math.max(3.4, Math.min(16.5, camDist.current + e.deltaY * 0.012));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gl]);

  // First-person mouselook: the canvas grabs the pointer (no click-dragging),
  // the mouse steers where you look — down to your feet, up to the peaks.
  const camPitch = useRef(0);
  useEffect(() => {
    const el = gl.domElement;
    const tryLock = () => {
      if (IS_TOUCH) return; // phones have no pointer to lock — touch-drag steers instead
      if (fpRef.current && document.pointerLockElement !== el) {
        el.requestPointerLock?.();
      }
    };
    if (firstPerson) tryLock(); // V keypress counts as the user gesture
    else if (document.pointerLockElement === el) document.exitPointerLock?.();
    const onMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== el || !fpRef.current) return;
      camYaw.current -= e.movementX * 0.0032;
      camPitch.current = Math.max(-1.05, Math.min(0.7, camPitch.current - e.movementY * 0.0028));
    };
    // Click the world to re-capture the mouse after Escape / closing a panel.
    el.addEventListener("click", tryLock);
    window.addEventListener("mousemove", onMove);
    return () => {
      el.removeEventListener("click", tryLock);
      window.removeEventListener("mousemove", onMove);
    };
  }, [gl, firstPerson]);

  // Drag (mouse or touch) to orbit the camera yaw around the character.
  // While dragging, resolution drops to 1x and shadow refreshes pause — a fast
  // 360° spin repaints the whole screen every frame, and full-res + shadows was
  // exactly the FPS cliff. Both restore the moment the pointer lifts.
  const draggingRef = useRef(false);
  useEffect(() => {
    const el = gl.domElement;
    let lastX = 0;
    let lastY = 0;
    // Track the ONE pointer that owns the look-drag — a stray second finger
    // (the joystick lives on its own DOM element, but a random touch on the
    // open canvas) must not hijack lastX/lastY and jerk or freeze the camera.
    let dragId: number | null = null;
    const pd = (e: PointerEvent) => {
      if (dragId !== null) return; // already dragging with another pointer
      dragId = e.pointerId;
      draggingRef.current = true;
      lastX = e.clientX;
      lastY = e.clientY;
      setDpr(1);
    };
    const pm = (e: PointerEvent) => {
      if (!draggingRef.current || e.pointerId !== dragId) return;
      camYaw.current -= (e.clientX - lastX) * (IS_TOUCH && fpRef.current ? 0.009 : 0.005);
      // In first person the drag also pitches the view — this is how touch
      // devices look up/down (no pointer lock on phones). Touch needs a much
      // hotter ratio: a thumb sweep covers a third of a mouse sweep.
      if (fpRef.current) {
        camPitch.current = Math.max(-1.05, Math.min(0.7, camPitch.current - (e.clientY - lastY) * (IS_TOUCH ? 0.0075 : 0.004)));
      }
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const pu = (e: PointerEvent) => {
      if (e.pointerId !== dragId) return; // ignore the non-owning finger lifting
      dragId = null;
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDpr(perfTier >= 2 ? 0.85 : perfTier >= 1 || lowPower ? 1 : fpRef.current ? 1.0 : 1.1);
    };
    el.addEventListener("pointerdown", pd);
    window.addEventListener("pointermove", pm);
    window.addEventListener("pointerup", pu);
    return () => {
      el.removeEventListener("pointerdown", pd);
      window.removeEventListener("pointermove", pm);
      window.removeEventListener("pointerup", pu);
    };
  }, [gl, setDpr, lowPower, perfTier]);

  // The frame loop mutates gl.shadowMap.needsUpdate for the throttled shadow
  // refresh — an intentional three.js pattern, hence the targeted disable.
  // eslint-disable-next-line react-hooks/immutability
  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    // The character hides ONLY while the camera is genuinely at the head:
    // first-person AND not in sky view AND not in the fishing cinematic.
    // (Runs before the early returns below so every state keeps it correct.)
    if (avatarWrap.current) {
      avatarWrap.current.visible = !(fpRef.current && !aerialRef.current && !fishRef.current);
    }
    const k = keys.current;
    const yaw = camYaw.current;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // forward (away from camera)
    const rx = Math.cos(yaw), rz = -Math.sin(yaw); // right (screen-right = D)
    let mx = 0, mz = 0;
    if (k["KeyW"] || k["ArrowUp"]) { mx += fx; mz += fz; }
    if (k["KeyS"] || k["ArrowDown"]) { mx -= fx; mz -= fz; }
    if (k["KeyD"] || k["ArrowRight"]) { mx += rx; mz += rz; }
    if (k["KeyA"] || k["ArrowLeft"]) { mx -= rx; mz -= rz; }
    // Virtual joystick (mobile) merges in camera-relative, like the keys.
    const tc = touchRef?.current;
    if (tc && (tc.mx !== 0 || tc.my !== 0)) {
      mx += fx * tc.my + rx * tc.mx;
      mz += fz * tc.my + rz * tc.mx;
    }
    let moving = mx !== 0 || mz !== 0;
    const running = k["ShiftLeft"] || k["ShiftRight"] || !!(tc && tc.run);
    // Eating food grants a short sprint boost.
    const boosted = (boostRef?.current ?? 0) > Date.now();
    const speed = (running ? RUN_SPEED : WALK_SPEED) * (boosted ? 1.25 : 1);

    // Fishing: locked out on the dock with a cinematic side camera. Any
    // movement key asks the fishing manager to reel in (which unlocks us).
    if (fishRef.current) {
      const spot = fishRef.current;
      if (moving || k["Space"]) onFishMove();
      pos.current.set(spot.sx, 0, spot.sz);
      facing.current = spot.ry;
      gait.current.speed = 0;
      gait.current.mode = "fish";
      if (ref.current) {
        ref.current.position.set(spot.sx, 0, spot.sz);
        ref.current.rotation.y = spot.ry;
      }
      poseRef.current.x = spot.sx;
      poseRef.current.z = spot.sz;
      poseRef.current.ry = spot.ry;
      poseRef.current.st = "fish";
      if (aerialRef.current) {
        const R = worldRadius;
        target.current.set(0, R * 0.6, R * 0.5);
        camera.position.lerp(target.current, 1 - Math.exp(-4 * dt));
        camera.lookAt(0, 0, 0);
      } else {
        // Cinematic: slightly above and to the side, framing player + bobber.
        const dirX = Math.sin(spot.ry), dirZ = Math.cos(spot.ry);
        const rightX = Math.cos(spot.ry), rightZ = -Math.sin(spot.ry);
        target.current.set(spot.sx + rightX * 4.8 - dirX * 3.2, 3.6, spot.sz + rightZ * 4.8 - dirZ * 3.2);
        camera.position.lerp(target.current, 1 - Math.exp(-3.5 * dt));
        lookAt.current.set((spot.sx + spot.bx) / 2, 0.7, (spot.sz + spot.bz) / 2);
        camera.lookAt(lookAt.current);
      }
      return;
    }

    // Lying in the bed (interior only): eyes on the ceiling until you move.
    if (restRef?.current && interiorRef.current) {
      const bx = INTERIOR_POS.x - 3.6, bz = INTERIOR_POS.z - 3.6;
      if (moving || k["Space"]) {
        restRef.current = false;
        onRestEnd?.();
        pos.current.set(bx + 1.9, 0, bz + 0.4); // step out beside the bed
      } else {
        pos.current.set(bx, 0, bz - 0.4);
        gait.current.speed = 0;
        poseRef.current.x = bx;
        poseRef.current.z = bz - 0.4;
        poseRef.current.st = "sit";
        // First-person from the pillow: eye just above the mattress, looking
        // up at the beams and the hanging lamp.
        const eye = 1.06;
        target.current.set(bx, eye, bz - 0.7);
        camera.position.lerp(target.current, 1 - Math.exp(-6 * dt));
        lookAt.current.set(bx, 7.5, bz + 1.3);
        camera.lookAt(lookAt.current);
        return;
      }
    }

    // Sitting on a bench: locked to the seat until a movement key stands us up.
    if (sitRef.current) {
      const seat = sitRef.current;
      if (moving || k["Space"]) {
        sitRef.current = null;
        onSitting(false);
        // Step clear of the bench (past its collider) so we don't get stuck.
        pos.current.set(seat.x + Math.sin(seat.ry) * 1.7, 0, seat.z + Math.cos(seat.ry) * 1.7);
      } else {
        pos.current.set(seat.x, 0, seat.z);
        facing.current = seat.ry;
        gait.current.speed = 0;
        gait.current.mode = "sit";
        if (ref.current) {
          ref.current.position.set(seat.x, 0, seat.z);
          ref.current.rotation.y = seat.ry;
        }
        poseRef.current.x = seat.x;
        poseRef.current.z = seat.z;
        poseRef.current.ry = seat.ry;
        poseRef.current.st = "sit";
        // Camera still follows (aerial/first-person handled below as usual).
        moving = false;
        if (!aerialRef.current) {
          if (fpRef.current) {
            // Seated first-person: eyes at seated head height, looking OUT the
            // way the seat faces — the view from the bench, not into it.
            const eye = 1.16;
            target.current.set(seat.x - Math.sin(seat.ry) * 0.08, eye, seat.z - Math.cos(seat.ry) * 0.08);
            camera.position.lerp(target.current, 1 - Math.exp(-8 * dt));
            lookAt.current.set(seat.x + Math.sin(seat.ry) * 6, eye - 0.25, seat.z + Math.cos(seat.ry) * 6);
            camera.lookAt(lookAt.current);
          } else {
            const back = camDist.current;
            const seatCamH = Math.max(2.1, CAM_HEIGHT * (camDist.current / CAM_DIST));
            target.current.set(seat.x + Math.sin(yaw) * back, seatCamH, seat.z + Math.cos(yaw) * back);
            camera.position.lerp(target.current, 1 - Math.exp(-6 * dt));
            lookAt.current.set(seat.x, 1.4, seat.z);
            camera.lookAt(lookAt.current);
          }
        } else {
          const R = worldRadius;
          target.current.set(0, R * 0.6, R * 0.5);
          camera.position.lerp(target.current, 1 - Math.exp(-4 * dt));
          camera.lookAt(0, 0, 0);
        }
        return;
      }
    }
    gait.current.mode = null;

    if (moving) {
      const len = Math.hypot(mx, mz);
      mx /= len; mz /= len;
      let nx = pos.current.x + mx * speed * dt;
      let nz = pos.current.z + mz * speed * dt;
      if (interiorRef.current) {
        // Inside the house: the room box is the whole world — and the
        // furniture pushes back, same circle-collider maths as outside.
        nx = Math.min(INTERIOR_POS.x + 5.0, Math.max(INTERIOR_POS.x - 5.0, nx));
        nz = Math.min(INTERIOR_POS.z + 5.6, Math.max(INTERIOR_POS.z - 5.0, nz));
        for (let iter = 0; iter < 2; iter++) {
          for (const s of INTERIOR_SOLIDS) {
            const sx = INTERIOR_POS.x + s.x, sz = INTERIOR_POS.z + s.z;
            const dx = nx - sx, dz = nz - sz;
            const dist = Math.hypot(dx, dz);
            const min = s.r + PLAYER_RADIUS;
            if (dist < min && dist > 1e-4) {
              nx = sx + (dx / dist) * min;
              nz = sz + (dz / dist) * min;
            }
          }
        }
        pos.current.set(nx, 0, nz);
        facing.current = Math.atan2(mx, mz);
      } else {
      for (let iter = 0; iter < 2; iter++) {
        for (const s of solids) {
          const dx = nx - s.x, dz = nz - s.z;
          const dist = Math.hypot(dx, dz);
          const min = s.r + PLAYER_RADIUS;
          if (dist < min && dist > 1e-4) {
            nx = s.x + (dx / dist) * min;
            nz = s.z + (dz / dist) * min;
          }
        }
      }
      // Other players are solid — no walking through each other.
      for (const [, peerPose] of peersRef?.current ?? []) {
        const dx = nx - peerPose.x, dz = nz - peerPose.z;
        const dist = Math.hypot(dx, dz);
        const min = 0.55 + PLAYER_RADIUS;
        if (dist < min && dist > 1e-4) {
          nx = peerPose.x + (dx / dist) * min;
          nz = peerPose.z + (dz / dist) * min;
        }
      }
      // The animals are solid too (they wander, so they're checked live).
      for (const a of animalsRef?.current ?? []) {
        const dx = nx - a.x, dz = nz - a.z;
        const dist = Math.hypot(dx, dz);
        const min = 0.85 + PLAYER_RADIUS;
        if (dist < min && dist > 1e-4) {
          nx = a.x + (dx / dist) * min;
          nz = a.z + (dz / dist) * min;
        }
      }
      const rad = Math.hypot(nx, nz);
      if (rad > worldRadius) { nx = (nx / rad) * worldRadius; nz = (nz / rad) * worldRadius; }
      pos.current.set(nx, 0, nz);
      facing.current = Math.atan2(mx, mz);
      }
    }
    // Drive the avatar's limb animation.
    gait.current.speed = moving ? (running ? 1.6 : 1) : 0;

    // Footsteps — one soft tap per stride; stone inside the plaza, grass
    // everywhere else. Timer resets when standing so the first step lands fast.
    if (moving && grounded.current) {
      stepClock.current += dt * (running ? 1.55 : 1);
      if (stepClock.current > 0.38) {
        stepClock.current = 0;
        worldSfx.step(Math.hypot(pos.current.x, pos.current.z) < 12 ? "stone" : "grass");
      }
    } else {
      stepClock.current = 0.3;
    }

    // Bounce mushrooms: standing on a cap launches you sky-high (and tells the
    // mushroom so it can squash).
    if (grounded.current) {
      for (const bp of padsRef.current) {
        if (Math.hypot(pos.current.x - bp.x, pos.current.z - bp.z) < bp.r) {
          jumpV.current = JUMP_V * 2.2;
          grounded.current = false;
          if (bounceFxRef) bounceFxRef.current = { x: bp.x, z: bp.z, t: performance.now() };
          break;
        }
      }
    }
    // Jump + gravity.
    if ((k["Space"] || k["KeyZ"]) && grounded.current) {
      jumpV.current = JUMP_V;
      grounded.current = false;
    }
    if (!grounded.current) {
      jumpV.current -= GRAVITY * dt;
      jumpH.current += jumpV.current * dt;
      if (jumpH.current <= 0) { jumpH.current = 0; jumpV.current = 0; grounded.current = true; }
    }
    const bob = moving && grounded.current ? Math.abs(Math.sin(state.clock.elapsedTime * (running ? 16 : 10))) * 0.06 : 0;

    if (ref.current) {
      ref.current.position.set(pos.current.x, jumpH.current + bob, pos.current.z);
      ref.current.rotation.y = facing.current;
    }

    // Publish our pose for the presence sender (throttled elsewhere).
    poseRef.current.x = pos.current.x;
    poseRef.current.z = pos.current.z;
    poseRef.current.ry = facing.current;
    poseRef.current.st = !grounded.current ? "jump" : moving ? (running ? "run" : "walk") : "idle";

    // Nearest interactable building (only report when it changes).
    let best: string | null = null;
    let bestD = INTERACT_RANGE;
    for (const b of buildingsRef.current) {
      const d = Math.hypot(pos.current.x - b.x, pos.current.z - b.z);
      if (d < bestD) { bestD = d; best = b.key; }
    }
    if (best !== nearest.current) { nearest.current = best; onNearest(best); }

    // Nearest sittable bench (takes E-priority over buildings when close).
    let bench: BenchSpot | null = null;
    let benchD = 2.4;
    for (const bs of benchesRef.current) {
      const d = Math.hypot(pos.current.x - bs.x, pos.current.z - bs.z);
      if (d < benchD) { benchD = d; bench = bs; }
    }
    if (bench !== nearBenchRef.current) {
      const was = !!nearBenchRef.current;
      nearBenchRef.current = bench;
      if (was !== !!bench) onNearBench(!!bench);
    }

    // Throttled shadow refresh — every 3rd frame is invisible to the eye but
    // cuts a full shadow render pass off most frames.
    frame.current++;
    const yawDelta = Math.abs(camYaw.current - lastYawRef.current);
    lastYawRef.current = camYaw.current;
    if (frame.current % (fpRef.current ? 6 : 3) === 0 && !aerialRef.current && !draggingRef.current && yawDelta < 0.02) {
      // eslint-disable-next-line react-hooks/immutability -- intentional three.js shadow-refresh pattern
      gl.shadowMap.needsUpdate = true;
    }

    // Camera: aerial bird's-eye of the whole world, first-person, or third-person
    // (with scroll-wheel zoom — height follows distance so the pitch stays nice).
    const eyeY = 1.75 + jumpH.current;
    if (aerialRef.current) {
      const R = worldRadius;
      target.current.set(0, R * 0.6, R * 0.5);
      camera.position.lerp(target.current, 1 - Math.exp(-4 * dt));
      camera.lookAt(0, 0, 0);
    } else if (fpRef.current) {
      // eslint-disable-next-line react-hooks/immutability -- consuming the one-shot teleport flag per-frame is the point
      camSnap.current = false; // FP places the camera absolutely every frame
      camera.position.set(pos.current.x, eyeY, pos.current.z);
      const pitch = camPitch.current;
      const ch = Math.cos(pitch);
      lookAt.current.set(pos.current.x + fx * ch, eyeY + Math.sin(pitch), pos.current.z + fz * ch);
      camera.lookAt(lookAt.current);
    } else {
      const dist = camDist.current;
      const camH = Math.max(2.1, CAM_HEIGHT * (dist / CAM_DIST));
      target.current.set(
        pos.current.x + Math.sin(yaw) * dist,
        camH + jumpH.current * 0.4,
        pos.current.z + Math.cos(yaw) * dist
      );
      if (camSnap.current) {
        camSnap.current = false;
        camera.position.copy(target.current);
      } else {
        camera.position.lerp(target.current, 1 - Math.exp(-9 * dt));
      }
      camera.lookAt(pos.current.x, 1.4 + (dist / CAM_DIST) * 0.6 + jumpH.current, pos.current.z);
    }
  });

  return (
    <group ref={ref}>
      {/* The avatar hides only while the camera is truly at the head — during
          the fishing cinematic or sky view the camera is elsewhere, so the
          character must stay visible even in first-person mode. Visibility is
          driven per-frame (avatarWrap) since those states live in refs. */}
      <group ref={avatarWrap}>
        <Avatar look={look} gait={gait} hidden={false} />
      </group>
      {!firstPerson && <NamePlate text={name} />}
      {!firstPerson && selfId && <BubbleFollower id={selfId} bubblesRef={bubblesRef} />}
    </group>
  );
}

// A floating marker above an agent-building. Buildings you own glow teal (your
// district); the nearest building gets a pulsing ground ring so you know what
// "E" will open. Owned + tall beam for your agents.
function Beacon({ b, active, mine }: { b: WorldBuilding; active: boolean; mine: boolean }) {
  const marker = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  // Hover just above THIS house's sign (sign centre = roofPeak + 1.3, half a
  // sign tall) — a fixed height floats absurdly over small houses and clips
  // through the lettering on tall ones.
  const markerY = (b.peak ?? 6.5) + 2.7;
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (marker.current) {
      marker.current.position.y = markerY + Math.sin(t * 2 + b.x) * 0.25;
      marker.current.rotation.y = t * 1.2;
    }
    if (ring.current) {
      const s = 1 + Math.sin(t * 4) * 0.08;
      ring.current.scale.set(s, s, s);
    }
  });
  const col = mine ? "#5eead4" : "#8fe3c8";
  const emis = mine ? "#14b8a6" : "#4bbf9a";
  const ringCol = mine ? "#5eead4" : "#ffd166";
  return (
    <group position={[b.x, 0, b.z]}>
      {/* A soft beam over your own agents so you can spot your district */}
      {mine && (
        <mesh position={[0, markerY + 2.5, 0]}>
          <cylinderGeometry args={[0.14, 0.14, 6, 8]} />
          <meshBasicMaterial color="#5eead4" transparent opacity={0.35} toneMapped={false} />
        </mesh>
      )}
      <mesh ref={marker} position={[0, 11.1, 0]}>
        <octahedronGeometry args={[active ? 0.5 : mine ? 0.44 : 0.34, 0]} />
        <meshStandardMaterial
          color={active ? "#ffd166" : col}
          emissive={active ? "#ffb703" : emis}
          emissiveIntensity={active ? 1.4 : mine ? 1.1 : 0.7}
          toneMapped={false}
        />
      </mesh>
      {active && (
        <mesh ref={ring} position={[0, 0.18, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[2.2, 2.7, 40]} />
          <meshStandardMaterial color={ringCol} emissive={ringCol} emissiveIntensity={0.9} transparent opacity={0.8} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

function Beacons({
  buildings,
  nearestKey,
  mineKeys,
  poseRef,
}: {
  buildings: WorldBuilding[];
  nearestKey: string | null;
  mineKeys: Set<string>;
  poseRef: { current: PeerPose };
}) {
  return (
    <>
      {buildings.map((b) => (
        <RangedVisible key={b.key} x={b.x} z={b.z} range={60} poseRef={poseRef}>
          <Beacon b={b} active={b.key === nearestKey} mine={mineKeys.has(b.key)} />
        </RangedVisible>
      ))}
    </>
  );
}

function short(addr: string | null): string {
  if (!addr) return "—";
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

interface AgentActivity {
  running: number;
  queued: number;
  lastCompletedAt: string | null;
  completed24h: number;
}

// One-line "what is this agent doing NOW" for the storefront panel.
function activityLine(a: AgentActivity): { text: string; accent: string } {
  if (a.running > 0) {
    const q = a.queued > 0 ? ` · ${a.queued} in queue` : "";
    return { text: `● Working on ${a.running > 1 ? `${a.running} tasks` : "a task"} right now${q}`, accent: "text-emerald-600" };
  }
  if (a.queued > 0) {
    return { text: `◔ ${a.queued} task${a.queued > 1 ? "s" : ""} waiting in queue`, accent: "text-amber-600" };
  }
  // Fresh completions are social proof — show them. Stale silence isn't:
  // "idle for 17 days" reads as a dead network, so it becomes availability.
  if (a.lastCompletedAt && Date.now() - new Date(a.lastCompletedAt).getTime() < 48 * 3_600_000) {
    return { text: `○ Idle — last job finished ${timeAgo(a.lastCompletedAt)}`, accent: "text-gray-500" };
  }
  return { text: "○ Available for hire now", accent: "text-teal-600" };
}

function AgentCard({
  agent,
  mine,
  orderSteps,
  onAddStep,
  onEnterHome,
  onClose,
}: {
  agent: WorldPlot;
  mine: boolean;
  /** Open work order (walk-the-pipeline); null when no order is active. */
  orderSteps: string[] | null;
  onAddStep?: (agentId: string) => void;
  onEnterHome?: (agentId: string, name: string) => void;
  onClose: () => void;
}) {
  // Storefront data — the house is a shop window for the agent. Cross-listing
  // badge, services/price and live activity load per open (the card is keyed by
  // agentId at the call site, so state resets per agent).
  const [agencListed, setAgencListed] = useState(false);
  const [services, setServices] = useState<{ price: string | null; capabilities: string[] } | null>(null);
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/agenc/cross-list?agentId=${encodeURIComponent(agent.agentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { listing: unknown } | null) => {
        if (alive && d?.listing) setAgencListed(true);
      })
      .catch(() => { /* badge simply stays hidden */ });
    fetch(`/api/agents/${encodeURIComponent(agent.agentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { price?: string | null; capabilities?: string[] } | null) => {
        if (alive && d) setServices({ price: d.price ?? null, capabilities: d.capabilities ?? [] });
      })
      .catch(() => { /* hire button falls back to no price */ });
    fetch(`/api/world/agent/${encodeURIComponent(agent.agentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AgentActivity | null) => {
        if (alive && d) setActivity(d);
      })
      .catch(() => { /* live line simply stays hidden */ });
    return () => { alive = false; };
  }, [agent.agentId]);
  const price = services?.price?.trim();
  const live = activity ? activityLine(activity) : null;
  return (
    <div className={PANEL_WRAP} onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-sm rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`bg-gradient-to-br ${mine ? "from-amber-500 to-orange-600" : "from-emerald-500 to-teal-600"} px-6 py-5 text-white`}>
          <p className="text-[11px] tracking-[0.3em] font-mono text-white/80">{mine ? "YOUR AGENT" : "AGENT"}</p>
          <h2 className="text-xl font-bold leading-tight flex items-center gap-2">
            {agent.name}
            {agent.verified && <span className="text-xs bg-white/25 rounded-full px-2 py-0.5">✓ verified</span>}
            {agencListed && <span className="text-xs bg-pink-500/80 rounded-full px-2 py-0.5">✓ AgenC</span>}
          </h2>
          <p className="text-white/85 text-sm mt-1">{agent.district}</p>
        </div>
        <div className="grid grid-cols-2 gap-px bg-gray-100">
          <Stat label="Reputation" value={Math.round(agent.reputation).toString()} />
          <Stat label="Tasks done" value={agent.tasksCompleted.toLocaleString()} />
          <Stat label="USDC earned" value={`$${agent.usdcEarned.toFixed(2)}`} />
          <Stat label="Last 24h" value={activity ? `${activity.completed24h} job${activity.completed24h === 1 ? "" : "s"}` : "…"} />
        </div>
        {live && (
          <div className="px-6 pt-3">
            <p className={`text-sm font-semibold ${live.accent}`}>{live.text}</p>
          </div>
        )}
        {services && services.capabilities.length > 0 && (
          <div className="px-6 pt-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1.5">Services</p>
            <div className="flex flex-wrap gap-1.5">
              {services.capabilities.slice(0, 8).map((c) => (
                <span key={c} className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2 py-0.5">
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}
        {orderSteps !== null && (
          <div className="px-6 pt-3">
            {orderSteps.includes(agent.agentId) ? (
              <div className="w-full text-center rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-700 font-bold py-2 text-sm">
                ✓ Step {orderSteps.indexOf(agent.agentId) + 1} of your work order
              </div>
            ) : orderSteps.length >= 3 ? (
              <div className="w-full text-center rounded-xl bg-gray-100 text-gray-400 font-semibold py-2 text-sm">
                Work order full (3 steps)
              </div>
            ) : (
              <button
                onClick={() => onAddStep?.(agent.agentId)}
                className="w-full rounded-xl bg-gradient-to-r from-indigo-600 to-violet-700 text-white font-bold py-2.5 shadow-lg hover:brightness-110 transition"
              >
                ＋ Add to work order — step {orderSteps.length + 1}
              </button>
            )}
          </div>
        )}
        <div className="px-6 pt-4">
          {mine ? (
            <a
              href="/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 text-white font-bold py-2.5 shadow-lg hover:brightness-110 transition"
            >
              Manage your agent →
            </a>
          ) : null}
          {mine && onEnterHome ? (
            <button
              onClick={() => onEnterHome(agent.agentId, agent.name)}
              className="mt-2 block w-full text-center rounded-xl border-2 border-amber-500 text-amber-700 font-bold py-2 hover:bg-amber-50 transition"
            >
              🏠 Enter your house
            </button>
          ) : null}
          {!mine && (
            <a
              href={`/agents/${encodeURIComponent(agent.agentId)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-bold py-2.5 shadow-lg hover:brightness-110 transition"
            >
              Hire this agent{price ? ` — ${price}` : ""} →
            </a>
          )}
          <p className="text-center text-[11px] text-gray-400 mt-1.5">
            {mine ? "pricing, pause and earnings in the dashboard" : price ? "per task · paid via x402 · settles on Solana" : "opens the agent's page"}
          </p>
        </div>
        <div className="px-6 py-4 flex items-center justify-between">
          <span className="text-xs text-gray-500 font-mono">{short(agent.walletAddress)}</span>
          <button onClick={onClose} className="text-sm font-semibold text-gray-700 hover:text-gray-900">Close ✕</button>
        </div>
      </div>
    </div>
  );
}

interface PipelineRunState {
  workflowId: string;
  status: "running" | "completed" | "failed";
  currentStep: number;
  agents: string[];
  steps: { toAgent: string; status: string }[];
  finalOutput?: string;
}

// The pipeline desk panel: review the work order assembled on foot, describe
// the job, and RUN it — a real workflow where each agent's output feeds the
// next. Live progress per step; the final result appears when the last agent
// finishes.
function PipelinePanel({
  steps,
  names,
  run,
  onRemoveLast,
  onReset,
  onRun,
  onLocate,
  onClose,
}: {
  steps: string[];
  names: Map<string, WorldPlot>;
  run: PipelineRunState | null;
  onRemoveLast: () => void;
  onReset: () => void;
  onRun: (task: string) => Promise<string | null>;
  onLocate: (agentId: string) => void;
  onClose: () => void;
}) {
  const [task, setTask] = useState("Research the latest x402 developments and summarize the 3 most important ones.");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const nameOf = (id: string) => names.get(id)?.name ?? id;
  const start = async () => {
    setStarting(true);
    setError("");
    const err = await onRun(task);
    if (err) setError(err);
    setStarting(false);
  };
  return (
    <div className={PANEL_WRAP} onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className={`relative w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-y-auto ${PANEL_MAXH}`} onClick={(e) => e.stopPropagation()}>
        <div className="bg-gradient-to-br from-indigo-600 to-violet-700 px-6 py-4 text-white flex items-center justify-between">
          <div>
            <p className="text-[11px] tracking-[0.3em] font-mono text-white/80">PIPELINE DESK</p>
            <h2 className="text-lg font-bold">{run ? "Pipeline running" : "Your work order"}</h2>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white text-xl leading-none">✕</button>
        </div>

        {run ? (
          <div className="p-5 space-y-3">
            {run.agents.map((id, i) => {
              const st = run.steps.find((s) => s.toAgent === id)?.status;
              const done = st === "completed";
              const active = !done && (st === "running" || st === "queued" || i === run.currentStep) && run.status === "running";
              return (
                <div key={id} className="flex items-center gap-3">
                  <span className={`w-4 h-4 rounded-full shrink-0 ${done ? "bg-emerald-500" : active ? "border-2 border-indigo-300 border-t-indigo-600 animate-spin" : "border-2 border-gray-300"}`} />
                  <p className={`text-sm font-semibold ${done ? "text-gray-800" : active ? "text-indigo-700" : "text-gray-400"}`}>
                    Step {i + 1} — {nameOf(id)}
                  </p>
                </div>
              );
            })}
            {run.status === "completed" && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 max-h-72 overflow-auto">
                <p className="text-[11px] uppercase tracking-wide text-emerald-700 font-bold mb-1">Final output</p>
                <p className="text-xs text-gray-700 whitespace-pre-wrap">{run.finalOutput || "(empty)"}</p>
              </div>
            )}
            {run.status === "failed" && (
              <p className="text-sm text-red-600 font-semibold">A step failed — the agents couldn&apos;t finish this one.</p>
            )}
            {run.status !== "running" && (
              <button onClick={onReset} className="w-full rounded-xl bg-gradient-to-r from-indigo-600 to-violet-700 text-white font-bold py-2.5 shadow-lg hover:brightness-110 transition">
                Start a new work order
              </button>
            )}
            {run.status === "running" && (
              <p className="text-[11px] text-gray-400 text-center">each step is a real task — watch the working agent&apos;s house</p>
            )}
          </div>
        ) : (
          <div className="p-5 space-y-3">
            {steps.length === 0 ? (
              <p className="text-sm text-gray-600">
                No steps yet. Walk to an agent&apos;s house, press <span className="font-mono font-bold">E</span>, and hit
                <span className="font-semibold"> “Add to work order”</span>. Chain up to 3 agents — each one&apos;s output feeds the next.
              </p>
            ) : (
              <div className="space-y-2">
                {steps.map((id, i) => (
                  <div key={id} className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[11px] flex items-center justify-center shrink-0">{i + 1}</span>
                    {nameOf(id)}
                    <button onClick={() => onLocate(id)} className="text-[11px] text-teal-700 hover:text-teal-500 font-semibold" title="Light the way there">📍</button>
                    {i < steps.length - 1 && <span className="text-gray-300">↓</span>}
                  </div>
                ))}
                <button onClick={onRemoveLast} className="text-xs text-gray-500 hover:text-gray-800 underline">remove last step</button>
              </div>
            )}
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">The job</p>
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                maxLength={240}
                rows={3}
                className="w-full rounded-xl border border-gray-300 p-2.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            {error && <p className="text-xs text-red-600 font-semibold">{error}</p>}
            <button
              onClick={start}
              disabled={steps.length === 0 || task.trim().length < 10 || starting}
              className="w-full rounded-xl bg-gradient-to-r from-indigo-600 to-violet-700 text-white font-bold py-2.5 shadow-lg hover:brightness-110 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {starting ? "Starting…" : `Run the pipeline (${steps.length} step${steps.length === 1 ? "" : "s"}) →`}
            </button>
            <p className="text-center text-[11px] text-gray-400">a real workflow on the Axon network — free showcase run, 2 per hour</p>
          </div>
        )}
      </div>
    </div>
  );
}

interface BoardTask {
  openTaskId: string;
  task: string;
  capabilities: string[];
  maxBudget: string | null;
  createdAt: string;
  bids: { agentId: string; price: string }[];
}

// The job board read-out: the network's REAL open tasks with their live bids.
// Posting and bidding happen on the website — the world is where you SEE the
// bid race (each bidding agent's house lights a lantern).
function BidBoardPanel({ names, onLocate, onClose }: { names: Map<string, WorldPlot>; onLocate: (agentId: string) => void; onClose: () => void }) {
  const [tasks, setTasks] = useState<BoardTask[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/world/bid-board")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { tasks?: BoardTask[] } | null) => { if (alive) setTasks(d?.tasks ?? []); })
      .catch(() => { if (alive) setTasks([]); });
    return () => { alive = false; };
  }, []);
  return (
    <div className={PANEL_WRAP} onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className={`relative w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-y-auto ${PANEL_MAXH}`} onClick={(e) => e.stopPropagation()}>
        <div className="bg-gradient-to-br from-amber-600 to-orange-700 px-6 py-4 text-white flex items-center justify-between">
          <div>
            <p className="text-[11px] tracking-[0.3em] font-mono text-white/80">PLAZA JOB BOARD</p>
            <h2 className="text-lg font-bold">Live open tasks on the network</h2>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white text-xl leading-none">✕</button>
        </div>
        <div className="p-4 max-h-96 overflow-auto space-y-3">
          {tasks === null ? (
            <p className="text-sm text-gray-500 text-center py-4">Reading the board…</p>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">Nothing pinned right now — post the first task!</p>
          ) : (
            tasks.map((t) => (
              <div key={t.openTaskId} className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                <p className="text-sm font-semibold text-gray-800">{t.task}</p>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {t.capabilities.map((c) => (
                    <span key={c} className="text-[10px] bg-white border border-amber-200 text-amber-800 rounded-full px-2 py-0.5">{c}</span>
                  ))}
                  {t.maxBudget && (
                    <span className="text-[10px] bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-full px-2 py-0.5">up to {t.maxBudget}</span>
                  )}
                </div>
                {t.bids.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {t.bids.map((b, i) => (
                      <p key={i} className="text-xs text-gray-600 flex items-center justify-between">
                        <span className="flex items-center gap-1.5">
                          <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                          {names.get(b.agentId)?.name ?? b.agentId}
                          <button
                            onClick={() => onLocate(b.agentId)}
                            className="text-teal-700 hover:text-teal-500 font-semibold"
                            title="Light the way to this agent's house"
                          >
                            📍 locate
                          </button>
                        </span>
                        <span className="font-mono">{b.price}</span>
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 mt-2">No bids yet</p>
                )}
              </div>
            ))
          )}
        </div>
        <div className="px-4 pb-4">
          <a
            href="/open-tasks"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center rounded-xl bg-gradient-to-r from-amber-600 to-orange-700 text-white font-bold py-2.5 shadow-lg hover:brightness-110 transition"
          >
            Post or bid on the website →
          </a>
          <p className="text-center text-[11px] text-gray-400 mt-1.5">bidding agents&apos; houses show a lantern by the door</p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-white px-5 py-3">
      <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-lg font-bold ${accent ?? "text-gray-800"}`}>{value}</p>
    </div>
  );
}

// Gift chests: per-house-per-day claims plus a small daily total, so visiting
// is rewarding without being farmable. Tracked per browser (localStorage).
const GIFTS_PER_DAY = 5;
const GIFT_CLAIMS_KEY = "axon.world.gifts";
const giftDay = () => new Date().toISOString().slice(0, 10);

// Sound-effects preference (on unless explicitly muted).
function loadSfxPref(): boolean {
  if (typeof window === "undefined") return true;
  try { return localStorage.getItem("axon.world.sfx") !== "off"; } catch { return true; }
}

// Today's already-claimed chests, restored from the browser (empty on the
// server render — the chests only exist inside the client-only canvas).
function loadGiftClaims(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(GIFT_CLAIMS_KEY) ?? "null") as { day: string; ids: string[] } | null;
    if (raw && raw.day === giftDay() && Array.isArray(raw.ids)) return new Set(raw.ids);
  } catch { /* fresh day */ }
  return new Set();
}

// A deterministic outfit for each house's resident — the same agent always
// answers the door in the same look, and every agent's look is distinct
// (hashed from the agent id into the avatar palettes).
function residentLook(agentId: string): AvatarLook {
  let h = 2166136261;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const pick = <T,>(arr: readonly T[], shift: number): T => arr[(h >>> shift) % arr.length];
  return {
    skin: pick(PALETTES.skin, 2),
    hair: pick(PALETTES.hair, 5),
    hairStyle: pick(["short", "ponytail", "bun", "spiky"] as const, 8),
    hat: pick(PALETTES.hat, 11),
    // Mostly bare heads so the hairstyles read; the occasional hat for variety.
    hatStyle: pick(["none", "none", "none", "none", "cap", "beanie", "bucket", "cowboy"] as const, 14),
    shirt: pick(PALETTES.shirt, 17),
    pants: pick(PALETTES.pants, 20),
  };
}

// The house's resident answering a knock — the real blocky avatar in that
// agent's outfit. Steps out of the doorway, waves hello (or shrugs "on a job"
// with a head-shake), then heads back inside. Mounted only during a knock.
function DoorGreeterFigure({ b, busy, name }: { b: WorldBuilding; busy: boolean; name: string }) {
  const look = useMemo(() => residentLook(b.key), [b.key]);
  const gait = useRef<Gait>({ speed: 0, mode: busy ? "deny" : "wave" });
  useEffect(() => { gait.current.mode = busy ? "deny" : "wave"; }, [busy]);
  const g = useRef<THREE.Group>(null);
  const start = useRef<number | null>(null);
  const rot = b.rot ?? 0;
  const w = b.w ?? 4;
  useFrame((state) => {
    if (start.current === null) start.current = state.clock.elapsedTime;
    const t = state.clock.elapsedTime - start.current;
    const grp = g.current;
    if (!grp) return;
    // Timeline: door swings (0–0.45s) → step out → greet → step back in.
    const out = t < 0.45 ? 0 : t < 1.15 ? (t - 0.45) / 0.7 : t < 4.5 ? 1 : Math.max(0, 1 - (t - 4.5) / 0.5);
    grp.visible = out > 0.02;
    const d = w / 2 - 0.2 + out * 1.05;
    grp.position.set(b.x + Math.sin(rot) * d, 0, b.z + Math.cos(rot) * d);
    grp.rotation.y = rot;
  });
  return (
    <group ref={g} visible={false}>
      <Avatar look={look} gait={gait} hidden={false} />
      <SpeechBubble text={busy ? "On a job right now!" : `Hi! I'm ${name}`} />
    </group>
  );
}

// Villagers wandering the WHOLE map — ambient life between the landmarks.
// Same avatar system and outfit hashing as the door residents. Each picks a
// random destination, walks there dodging the world's solids, and when two
// villagers (or a villager and you) cross paths they stop, face each other
// for a quick chat, then part ways toward fresh destinations.
const villagerSpots: { x: number; z: number }[] = [];
// What the residents say when they stop for a chat — picked at random per
// conversation so the town doesn't repeat one line forever.
const BOT_CHAT = [
  "Nice day on the network!",
  "Heard the Email Agent is slammed today.",
  "Did you see the task streaks last night? ✨",
  "I'm saving up for a fishing rod.",
  "Someone knocked on my door at 3am…",
  "The Hall of Fame changed again!",
  "Shipped twelve tasks before lunch.",
  "The garden fountain is my favourite spot.",
  "I hear the market stalls have new faces.",
  "Watch out for the deer — they bolt!",
  "The river's lovely at sunset.",
  "New agent moved into the district!",
  "My reputation's up two points this week.",
  "Have you tried knocking? They answer!",
] as const;

const BOTS: { seed: string; name: string; start: [number, number] }[] = [
  { seed: "villager-ada", name: "Ada", start: [14, 6] },
  { seed: "villager-bo", name: "Bo", start: [-20, 24] },
  { seed: "villager-cleo", name: "Cleo", start: [8, -30] },
  { seed: "villager-finn", name: "Finn", start: [-32, -12] },
  { seed: "villager-momo", name: "Momo", start: [30, 18] },
  { seed: "villager-sage", name: "Sage", start: [-8, 38] },
  { seed: "villager-juno", name: "Juno", start: [40, -8] },
  { seed: "villager-pip", name: "Pip", start: [-26, -34] },
];
function Villager({
  seed,
  name,
  slot,
  start,
  worldRadius,
  solidsRef,
  playerRef,
}: {
  seed: string;
  name: string;
  slot: number;
  start: [number, number];
  worldRadius: number;
  solidsRef: { current: Collider[] };
  playerRef: { current: PeerPose };
}) {
  const look = useMemo(() => residentLook(seed), [seed]);
  const gait = useRef<Gait>({ speed: 0, mode: null });
  const g = useRef<THREE.Group>(null);
  // mode: what the bot is doing right now — they idle, stroll, sometimes jog.
  const st = useRef({
    x: start[0], z: start[1], tx: start[0], tz: start[1], ry: 0,
    mode: "walk" as "idle" | "walk" | "sprint" | "chat",
    timer: 2 + (slot % 3), cool: 0, stuck: 0, stuckResets: 0,
  });
  const [chatLine, setChatLine] = useState<string | null>(null);
  const nameG = useRef<THREE.Group>(null);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = st.current;
    const grp = g.current;
    if (!grp) return;
    villagerSpots[slot] = { x: s.x, z: s.z };
    s.timer -= dt;
    s.cool -= dt;

    if (s.mode === "chat" || s.mode === "idle") {
      gait.current.speed = 0;
      if (s.timer <= 0) {
        if (s.mode === "chat") setChatLine(null);
        // Head somewhere new — mostly a stroll, sometimes a jog.
        s.mode = Math.random() < 0.18 ? "sprint" : "walk";
        s.timer = 999;
        const a = Math.random() * Math.PI * 2;
        const rad = 10 + Math.random() * Math.max(20, worldRadius * 0.75);
        s.tx = Math.cos(a) * rad;
        s.tz = Math.sin(a) * rad;
      }
    } else {
      const sp = s.mode === "sprint" ? 4.6 : 1.7;
      gait.current.speed = s.mode === "sprint" ? 1.6 : 0.6;
      const dx = s.tx - s.x;
      const dz = s.tz - s.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.2) {
        // Arrived: pause and take in the view, or move straight on.
        if (Math.random() < 0.55) {
          s.mode = "idle";
          s.timer = 2 + Math.random() * 5;
        } else {
          s.mode = Math.random() < 0.15 ? "sprint" : "walk";
          const a = Math.random() * Math.PI * 2;
          const rad = 10 + Math.random() * Math.max(20, worldRadius * 0.75);
          s.tx = Math.cos(a) * rad;
          s.tz = Math.sin(a) * rad;
        }
      } else {
        let nx = s.x + (dx / dist) * sp * dt;
        let nz = s.z + (dz / dist) * sp * dt;
        for (const so of solidsRef.current) {
          const ox = nx - so.x;
          const oz = nz - so.z;
          const d = Math.hypot(ox, oz);
          const min = so.r + 0.4;
          if (d < min && d > 1e-4) {
            nx = so.x + (ox / d) * min;
            nz = so.z + (oz / d) * min;
          }
        }
        const moved = Math.hypot(nx - s.x, nz - s.z);
        if (moved < sp * dt * 0.3) s.stuck += dt;
        else { s.stuck = 0; s.stuckResets = 0; }
        s.x = nx;
        s.z = nz;
        s.ry = Math.atan2(dx, dz);
        if (s.stuck > 1.2) {
          s.stuck = 0;
          s.stuckResets += 1;
          if (s.stuckResets >= 3) {
            // Re-picking targets hasn't freed us — we're wedged in geometry
            // (a riverbank pocket, a collider seam). Pop back to the spawn
            // point; at villager scale nobody sees the teleport.
            s.stuckResets = 0;
            s.x = start[0];
            s.z = start[1];
          }
          const a2 = Math.random() * Math.PI * 2;
          const rad2 = 10 + Math.random() * Math.max(20, worldRadius * 0.75);
          s.tx = Math.cos(a2) * rad2;
          s.tz = Math.sin(a2) * rad2;
        }
      }
      // Bump into someone? Stop for a chat.
      if (s.cool <= 0) {
        let met: { x: number; z: number } | null = null;
        for (let i = 0; i < villagerSpots.length; i++) {
          if (i === slot) continue;
          const o = villagerSpots[i];
          if (o && Math.hypot(o.x - s.x, o.z - s.z) < 1.7) { met = o; break; }
        }
        const pl = playerRef.current;
        if (!met && Math.hypot(pl.x - s.x, pl.z - s.z) < 1.6) met = { x: pl.x, z: pl.z };
        if (met) {
          s.mode = "chat";
          s.timer = 2.4 + Math.random() * 1.4;
          s.cool = 14;
          s.ry = Math.atan2(met.x - s.x, met.z - s.z);
          setChatLine(BOT_CHAT[Math.floor(Math.random() * BOT_CHAT.length)]);
        }
      }
    }
    grp.position.set(s.x, 0, s.z);
    grp.rotation.y = s.ry;
    // Distance budget: whole bot culls far away, the nameplate even sooner.
    const pd = Math.hypot(playerRef.current.x - s.x, playerRef.current.z - s.z);
    grp.visible = pd < 75;
    if (nameG.current) nameG.current.visible = pd < 40;
  });
  return (
    <group ref={g}>
      <Avatar look={look} gait={gait} hidden={false} />
      <group ref={nameG}>
        <NamePlate text={name} />
      </group>
      {chatLine && <SpeechBubble text={chatLine} />}
    </group>
  );
}

const EMOTE_KEYS = ["wave", "smile", "heart", "party", "sad", "sleep"];

const PALETTES = {
  skin: ["#f1cba5", "#e8c0a0", "#d9a878", "#bd8a5a", "#96603a", "#5e3a24"],
  hair: ["#2a2018", "#3a2a18", "#6b4a2a", "#9c6b3a", "#d9b44a", "#7a2e26", "#a83a3a", "#3a5a86"],
  shirt: ["#5bbfb0", "#5a9fd4", "#c0503e", "#d9a94a", "#6a9a4a", "#8a5aa8", "#e6e2d6", "#2a3550"],
  pants: ["#2a4a6e", "#3a5a8a", "#2a2620", "#5b3a26", "#5a6a3a", "#6a4a4a", "#3a3850", "#2e5a44"],
  hat: ["#7c4a2a", "#d9b44a", "#3a6b9e", "#a83a3a", "#3a8a6a", "#2a2822", "#e6e2d6", "#c05a9e"],
};

const HAIR_LABELS: Record<HairStyle, string> = { none: "None", short: "Short", ponytail: "Ponytail", bun: "Bun", spiky: "Spiky" };
const HAT_LABELS: Record<HatStyle, string> = { none: "None", cowboy: "Cowboy", cap: "Cap", beanie: "Beanie", bucket: "Bucket" };

function Swatches({ options, value, onPick }: { options: string[]; value: string; onPick: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((c) => (
        <button
          key={c}
          onClick={() => onPick(c)}
          className={`w-8 h-8 rounded-lg border-2 transition ${value === c ? "border-teal-600 scale-110" : "border-white/60"} shadow`}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

function StyleButtons<T extends string>({ options, labels, value, onPick }: { options: T[]; labels: Record<T, string>; value: T; onPick: (o: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onPick(o)}
          className={`px-3 py-1.5 rounded-lg text-sm font-semibold border-2 shadow-sm transition ${value === o ? "border-gray-800 bg-white text-gray-900" : "border-amber-200 bg-white/70 text-gray-600 hover:bg-white"}`}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

// Rotating 3D preview of the avatar for the character creator.
function PreviewSpin({ look }: { look: AvatarLook }) {
  const g = useRef<THREE.Group>(null);
  const gait = useRef<Gait>({ speed: 0 });
  useFrame((state) => { if (g.current) g.current.rotation.y = state.clock.elapsedTime * 0.7; });
  return (
    <group ref={g}>
      {/* Offset down so the body's centre is at the origin (fully framed) */}
      <group position={[0, -0.95, 0]}>
        <Avatar look={look} gait={gait} hidden={false} />
      </group>
    </group>
  );
}

function randomLook(): AvatarLook {
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  return {
    skin: pick(PALETTES.skin),
    hair: pick(PALETTES.hair),
    hairStyle: pick(HAIR_STYLES),
    hat: pick(PALETTES.hat),
    hatStyle: pick(HAT_STYLES),
    shirt: pick(PALETTES.shirt),
    pants: pick(PALETTES.pants),
  };
}

// The "Create Character" modal — live 3D preview + name, hair/hat styles and
// colour swatches, with Random + Apply. Wallet-gated; saves to your profile.
function CreateCharacter({
  look,
  setLook,
  name,
  setName,
  onSave,
  onClose,
}: {
  look: AvatarLook;
  setLook: (updater: (l: AvatarLook) => AvatarLook) => void;
  name: string;
  setName: (n: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<AvatarLook>) => setLook((l) => ({ ...l, ...patch }));
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative w-full max-w-3xl max-h-[92vh] rounded-2xl bg-[#f3ead2] shadow-2xl overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-teal-500 to-teal-600 px-6 py-4 flex items-center justify-between">
          <h2 className="text-2xl font-black text-white">Create Character</h2>
          <button onClick={onClose} className="w-9 h-9 rounded-lg bg-white/20 text-white text-xl hover:bg-white/30">✕</button>
        </div>

        <div className="flex-1 overflow-auto p-5 grid grid-cols-1 sm:grid-cols-[260px_1fr] gap-5">
          {/* Live preview */}
          <div className="rounded-2xl border-4 border-amber-200/70 bg-[#bfe6f2] overflow-hidden min-h-[320px]">
            <Canvas shadows camera={{ position: [0, 0.35, 4.6], fov: 38 }}>
              <ambientLight intensity={0.75} />
              <directionalLight position={[3, 5, 4]} intensity={1.1} castShadow />
              <PreviewSpin look={look} />
            </Canvas>
          </div>

          {/* Controls */}
          <div className="space-y-4">
            <div>
              <p className="text-xs font-bold tracking-wider text-amber-800/80 mb-1">NAME</p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 20))}
                placeholder="Your name"
                className="w-full rounded-lg border-2 border-amber-200 bg-white px-3 py-2 text-gray-800 focus:outline-none focus:border-teal-500"
              />
            </div>
            <div>
              <p className="text-xs font-bold tracking-wider text-amber-800/80 mb-1">SKIN</p>
              <Swatches options={PALETTES.skin} value={look.skin} onPick={(c) => set({ skin: c })} />
            </div>
            <div>
              <p className="text-xs font-bold tracking-wider text-amber-800/80 mb-1">HAIR</p>
              <StyleButtons options={HAIR_STYLES} labels={HAIR_LABELS} value={look.hairStyle} onPick={(o) => set({ hairStyle: o })} />
            </div>
            <div>
              <p className="text-xs font-bold tracking-wider text-amber-800/80 mb-1">HAIR COLOR</p>
              <Swatches options={PALETTES.hair} value={look.hair} onPick={(c) => set({ hair: c })} />
            </div>
            <div>
              <p className="text-xs font-bold tracking-wider text-amber-800/80 mb-1">HAT</p>
              <StyleButtons options={HAT_STYLES} labels={HAT_LABELS} value={look.hatStyle} onPick={(o) => set({ hatStyle: o })} />
            </div>
            <div>
              <p className="text-xs font-bold tracking-wider text-amber-800/80 mb-1">HAT COLOR</p>
              <Swatches options={PALETTES.hat} value={look.hat} onPick={(c) => set({ hat: c })} />
            </div>
            <div>
              <p className="text-xs font-bold tracking-wider text-amber-800/80 mb-1">SHIRT</p>
              <Swatches options={PALETTES.shirt} value={look.shirt} onPick={(c) => set({ shirt: c })} />
            </div>
            <div>
              <p className="text-xs font-bold tracking-wider text-amber-800/80 mb-1">PANTS</p>
              <Swatches options={PALETTES.pants} value={look.pants} onPick={(c) => set({ pants: c })} />
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-amber-200/60 flex gap-3">
          <button onClick={() => setLook(() => randomLook())} className="flex-1 rounded-xl bg-amber-100 text-amber-900 font-bold py-3 hover:bg-amber-200 border-2 border-amber-200">
            🎲 Random
          </button>
          <button onClick={() => { onSave(); onClose(); }} className="flex-[2] rounded-xl bg-teal-500 text-white font-bold py-3 hover:bg-teal-600 shadow">
            Apply ▸
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

// The epoch / standings board. Non-monetary: shows live activity rankings only.
// Any real $AXON reward stays hidden behind NEXT_PUBLIC_AXON_REWARDS_ENABLED,
// pending a rewards-model + regulatory/wording review.
function EpochPanel({
  epoch,
  myAgentIds,
  rewardsEnabled,
  onClose,
}: {
  epoch: EpochSnapshot;
  myAgentIds: Set<string>;
  rewardsEnabled: boolean;
  onClose: () => void;
}) {
  const [remaining, setRemaining] = useState(epoch.msRemaining);
  useEffect(() => {
    const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const mine = epoch.leaderboard.filter((l) => myAgentIds.has(l.agentId));
  return (
    <div className={PANEL_WRAP} onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className={`relative w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-y-auto ${PANEL_MAXH}`} onClick={(e) => e.stopPropagation()}>
        <div className="bg-gradient-to-br from-amber-500 to-orange-600 px-6 py-4 text-white">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] tracking-[0.3em] font-mono text-white/80">EPOCH {epoch.index}</p>
              <h2 className="text-xl font-bold">Season standings 🏆</h2>
            </div>
            <button onClick={onClose} className="text-white/80 hover:text-white text-lg">✕</button>
          </div>
          <p className="text-white/90 text-sm mt-1">
            Ends in <span className="font-semibold">{fmtRemaining(remaining)}</span> · {epoch.totals.tasks} tasks · ${epoch.totals.usdc.toFixed(0)} settled
          </p>
        </div>

        {mine.length > 0 && (
          <div className="bg-teal-50 px-6 py-2 text-sm text-teal-800 border-b border-teal-100">
            Your best this epoch: <b>#{mine[0].rank}</b> {mine[0].name} · {mine[0].score.toLocaleString()} pts
          </div>
        )}

        <ol className="max-h-72 overflow-auto divide-y divide-gray-100">
          {epoch.leaderboard.length === 0 && (
            <li className="px-6 py-4 text-sm text-gray-500">No activity yet this epoch — be the first.</li>
          )}
          {epoch.leaderboard.map((l) => (
            <li key={l.agentId} className={`px-6 py-2 flex items-center gap-3 ${myAgentIds.has(l.agentId) ? "bg-teal-50/60" : ""}`}>
              <span className={`w-7 text-center font-bold ${l.rank === 1 ? "text-amber-500" : l.rank <= 3 ? "text-gray-700" : "text-gray-400"}`}>
                {l.rank === 1 ? "👑" : l.rank}
              </span>
              <span className="flex-1 truncate text-sm text-gray-800">{l.name}</span>
              <span className="text-xs text-gray-500 whitespace-nowrap">{l.tasks}✓ · ${l.usdc.toFixed(0)}</span>
              <span className="text-sm font-semibold text-gray-900 w-16 text-right">{l.score.toLocaleString()}</span>
            </li>
          ))}
        </ol>

        <div className="px-6 py-3 border-t border-gray-100 text-xs text-gray-500">
          {rewardsEnabled ? (
            <span>Epoch rewards are enabled for this deployment.</span>
          ) : (
            <span>
              Standings are <b>recognition only</b> — points carry no token or monetary value. On-chain epoch
              rewards are not live (pending review).
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function World3D({ onExit, initialWallet = null }: { onExit: () => void; initialWallet?: string | null }) {
  const [solids, setSolids] = useState<Collider[]>([]);
  const [buildings, setBuildings] = useState<WorldBuilding[]>([]);
  const [snap, setSnap] = useState<WorldSnapshot | null>(null);
  const [nearestKey, setNearestKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [wallet, setWallet] = useState<string | null>(initialWallet);
  const [walletState, setWalletState] = useState<"idle" | "connecting" | "no-phantom" | "failed">("idle");
  const [look, setLook] = useState<AvatarLook>(DEFAULT_LOOK);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [firstPerson, setFirstPerson] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [aerial, setAerial] = useState(false); // "fly up to the sky" overview
  const [epoch, setEpoch] = useState<EpochSnapshot | null>(null);
  const [showEpoch, setShowEpoch] = useState(false);
  const rewardsEnabled = process.env.NEXT_PUBLIC_AXON_REWARDS_ENABLED === "1";

  // ——— Minigames + inventory + music ———
  const [fishSpots, setFishSpots] = useState<FishSpot[]>([]);
  const [benches, setBenches] = useState<BenchSpot[]>([]);
  const [fishPrompt, setFishPrompt] = useState<FishPrompt>("none");
  const [fishingSpot, setFishingSpot] = useState<FishSpot | null>(null);
  const fishCancel = useRef(0);
  const onFishMove = useCallback(() => { fishCancel.current++; }, []);
  const animalsRef = useRef<{ x: number; z: number }[]>([]);
  const [nearBench, setNearBench] = useState(false);
  const [nearPet, setNearPet] = useState(false);
  const [nearGather, setNearGather] = useState<"apple" | "berry" | "dig" | null>(null);
  const [gatherSpots, setGatherSpots] = useState<GatherSpot[]>([]);
  const [bouncePads, setBouncePads] = useState<{ x: number; z: number; r: number }[]>([]);
  const bounceFx = useRef<{ x: number; z: number; t: number } | null>(null); // squash FX for the mushroom that launched us
  const [worldExtent, setWorldExtent] = useState<number | null>(null);
  const [sitting, setSitting] = useState(false);
  const boostUntil = useRef(0); // eating food grants a short sprint boost
  const [showInv, setShowInv] = useState(false);
  const [inv, setInv] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<{ itemId: string; name: string; rarity: Rarity } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ringRun, setRingRun] = useState<RingRunState>({ running: false, startedAt: 0, idx: 0, finishedMs: null, best: null });
  const [musicOn, setMusicOn] = useState(false);
  const music = useRef<WorldMusic | null>(null);

  // Everything a minigame wins goes through here: count it + pop a toast.
  const addItem = useCallback((id: string) => {
    const def = ITEMS[id];
    if (!def) return;
    setInv((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
    setToast({ itemId: def.id, name: def.name, rarity: def.rarity });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  // ── Daily gift chests (active agents' houses) ─────────────────────────────
  // Anti-farm: one per house per day + a daily total cap, tracked per browser.
  const [chestSpots, setChestSpots] = useState<{ id: string; x: number; z: number }[]>([]);
  const [nearChest, setNearChest] = useState<string | null>(null);
  const nearChestRef = useRef<string | null>(null);
  useEffect(() => { nearChestRef.current = nearChest; }, [nearChest]);
  const [openedChests, setOpenedChests] = useState<Set<string>>(loadGiftClaims);
  const openedChestsRef = useRef(openedChests);
  useEffect(() => { openedChestsRef.current = openedChests; }, [openedChests]);
  const openGiftChest = useCallback((id: string) => {
    const cur = openedChestsRef.current;
    if (cur.has(id) || cur.size >= GIFTS_PER_DAY) return;
    const next = new Set(cur);
    next.add(id);
    openedChestsRef.current = next;
    setOpenedChests(next);
    worldSfx.chest();
    try {
      localStorage.setItem(GIFT_CLAIMS_KEY, JSON.stringify({ day: giftDay(), ids: [...next] }));
    } catch { /* per-session only */ }
    addItem(rollGift().id);
  }, [addItem]);
  const giftCapReached = openedChests.size >= GIFTS_PER_DAY;
  // E beside an unopened chest opens the CHEST, not the house card behind it —
  // the ChestManager claims it; this just keeps the card from opening on top.
  const onInteractBuilding = useCallback((key: string) => {
    if (!nearChestRef.current) setOpenKey(key);
  }, []);

  // ── Sound effects (one-shots live in worldSfx; this is the toggle + ambience)
  const [sfxOn, setSfxOn] = useState(loadSfxPref);
  const [showMenu, setShowMenu] = useState(false);
  const [showPerf, setShowPerf] = useState(false);
  const [perf, setPerf] = useState<{ fps: number; calls: number; tris: number; census: string[] } | null>(null);
  // The town breathes: residents come and go, so the population pill drifts
  // through the day instead of pinning at a constant.
  const [activeBots, setActiveBots] = useState(5);
  useEffect(() => {
    const drift = () => {
      setActiveBots((n) => {
        const step = Math.random() < 0.5 ? -1 : 1;
        return Math.max(3, Math.min(BOTS.length, n + step));
      });
    };
    const iv = setInterval(drift, 70_000 + Math.random() * 80_000);
    return () => clearInterval(iv);
  }, []);
  const toggleSfx = useCallback(() => setSfxOn((v) => !v), []);
  useEffect(() => {
    worldSfx.setEnabled(sfxOn);
    try { localStorage.setItem("axon.world.sfx", sfxOn ? "on" : "off"); } catch { /* per-session */ }
  }, [sfxOn]);
  // Sparse ambient birdsong. (Chirps before the first user gesture are silently
  // dropped by the browser's autoplay rules — that's fine.)
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      if (!alive) return;
      worldSfx.bird();
      timer = setTimeout(loop, 9000 + Math.random() * 14000);
    };
    timer = setTimeout(loop, 6000);
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  // ── Knock on the door (K near a house) ─────────────────────────────────────
  // The house's resident answers: door swings open, they step out and wave —
  // or apologise if the agent is genuinely mid-task (live activity API).
  const [knock, setKnock] = useState<{ id: string; name: string; busy: boolean } | null>(null);
  const nearestKeyRef = useRef<string | null>(null);
  useEffect(() => { nearestKeyRef.current = nearestKey; }, [nearestKey]);
  const buildingsRefHud = useRef<WorldBuilding[]>([]);
  useEffect(() => { buildingsRefHud.current = buildings; }, [buildings]);
  const knockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (knockTimer.current) clearTimeout(knockTimer.current); }, []);

  // ── Walk-the-pipeline: assemble a REAL multi-agent workflow on foot ───────
  const [deskSpot, setDeskSpot] = useState<{ x: number; z: number; ry: number } | null>(null);
  const [nearDesk, setNearDesk] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);
  // The work order: agent ids in walk order. null = no order open yet.
  const [orderSteps, setOrderSteps] = useState<string[] | null>(null);
  const [pipelineRun, setPipelineRun] = useState<PipelineRunState | null>(null);
  const openPipeline = useCallback(() => {
    setShowPipeline(true);
    setOrderSteps((s) => s ?? []); // first visit to the desk opens a work order
  }, []);
  const addOrderStep = useCallback((agentId: string) => {
    setOrderSteps((s) => {
      const cur = s ?? [];
      if (cur.includes(agentId) || cur.length >= 3) return s;
      return [...cur, agentId];
    });
  }, []);
  // Live progress while a pipeline runs — the running step is a real task, so
  // that agent's house shows it (chimney smoke, "working right now" card line).
  useEffect(() => {
    if (!pipelineRun || pipelineRun.status !== "running") return;
    const iv = setInterval(() => {
      fetch(`/api/world/pipeline?id=${encodeURIComponent(pipelineRun.workflowId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: PipelineRunState | null) => { if (d) setPipelineRun(d); })
        .catch(() => { /* next tick retries */ });
    }, 3000);
    return () => clearInterval(iv);
  }, [pipelineRun]);
  const runPipeline = useCallback(async (task: string): Promise<string | null> => {
    const steps = orderSteps ?? [];
    try {
      const res = await fetch("/api/world/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents: steps, task }),
      });
      const d = (await res.json().catch(() => null)) as { workflowId?: string; error?: unknown } | null;
      if (!res.ok || !d?.workflowId) {
        return typeof d?.error === "string" ? d.error : "The pipeline couldn't start — try again in a bit.";
      }
      setPipelineRun({ workflowId: d.workflowId, status: "running", currentStep: 0, agents: steps, steps: [] });
      return null;
    } catch {
      return "Couldn't reach the server.";
    }
  }, [orderSteps]);
  const resetPipeline = useCallback(() => {
    setPipelineRun(null);
    setOrderSteps([]);
  }, []);

  // ── Home interiors (Wave 6): step inside your own house ───────────────────
  const [homeIn, setHomeIn] = useState<{ agentId: string; name: string; back: [number, number] } | null>(null);
  const [warp, setWarp] = useState<[number, number] | null>(null);
  const [nearExit, setNearExit] = useState(false);
  // Indoors is FIRST PERSON ONLY: the room is a closed box, and an orbiting
  // third-person camera in a 11u room clips through walls and your own avatar.
  const fpBeforeHome = useRef(false);
  const [resting, setResting] = useState(false);
  const restRef = useRef(false);
  const enterHome = useCallback((agentId: string, name: string) => {
    setHomeIn({ agentId, name, back: [poseRef.current.x, poseRef.current.z] });
    setOpenKey(null);
    setWarp([INTERIOR_POS.x, INTERIOR_POS.z + 3.4]); // just inside the doorway
    setFirstPerson((prev) => {
      fpBeforeHome.current = prev;
      return true;
    });
  }, []);
  const exitHome = useCallback(() => {
    setHomeIn((h) => {
      if (h) setWarp([h.back[0], h.back[1]]);
      return null;
    });
    setFirstPerson(fpBeforeHome.current);
    restRef.current = false;
    setResting(false);
  }, []);
  // The house is USABLE: the desk terminal is a live dashboard for this agent,
  // and the bed skips the world clock forward (dusk on demand, indoors).
  const [showTerminal, setShowTerminal] = useState(false);
  const [nearTerminal, setNearTerminal] = useState(false);
  const [nearBed, setNearBed] = useState(false);
  const openTerminal = useCallback(() => {
    document.exitPointerLock?.(); // the panel needs a cursor
    setShowTerminal(true);
  }, []);
  // Rest is a moment, not a time machine — the world clock stays put. The
  // Player lies you down in the bed (camera on the pillow) until you move.
  const restInBed = useCallback(() => {
    restRef.current = true;
    setResting(true);
  }, []);
  const onRestEnd = useCallback(() => setResting(false), []);

  // ── Plaza job board (real open tasks + live bids) ──────────────────────────
  const [boardSpot, setBoardSpot] = useState<{ x: number; z: number; ry: number } | null>(null);
  // The plaza world-map board: E opens a live chart with locate buttons.
  const [mapSpot, setMapSpot] = useState<{ x: number; z: number; ry: number } | null>(null);
  const [landmarks, setLandmarks] = useState<WorldLandmarks | null>(null);
  const [nearMapBoard, setNearMapBoard] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const openMap = useCallback(() => {
    document.exitPointerLock?.();
    setShowMap(true);
  }, []);
  const [nearBoard, setNearBoard] = useState(false);
  const [nearDoorFront, setNearDoorFront] = useState(false);
  const [showBoard, setShowBoard] = useState(false);
  const openBoard = useCallback(() => setShowBoard(true), []);
  // Which agents have a live bid — their houses show a lantern by the door.
  const [bidderIds, setBidderIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/world/bid-board")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { tasks?: { bids: { agentId: string }[] }[] } | null) => {
          if (alive && d?.tasks) setBidderIds(new Set(d.tasks.flatMap((t) => t.bids.map((b) => b.agentId))));
        })
        .catch(() => { /* lanterns just stay off */ });
    };
    load();
    const iv = setInterval(load, 90_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  const onCatch = useCallback((item: ItemDef) => { worldSfx.splash(); addItem(item.id); }, [addItem]);
  const onHenCaught = useCallback(() => { worldSfx.pick(); addItem("golden_egg"); }, [addItem]);
  const onGather = useCallback(
    (kind: "apple" | "berry" | "dig") => {
      worldSfx.pick();
      if (kind === "apple") addItem("apple");
      else if (kind === "berry") addItem(Math.random() < 0.08 ? "golden_berry" : "berries");
      else {
        // Digging: mostly scrap, occasionally real treasure.
        const r = Math.random();
        addItem(r < 0.45 ? "rusty_gear" : r < 0.68 ? "pearl" : r < 0.82 ? "bottle_message" : r < 0.93 ? "ancient_coin" : r < 0.985 ? "teal_crystal" : "axon_relic");
      }
    },
    [addItem],
  );
  // Eat food from the inventory: consumes one + an 8s sprint boost.
  const eatItem = useCallback((id: string) => {
    const def = ITEMS[id];
    if (!def?.food) return;
    setInv((prev) => {
      const n = (prev[id] ?? 0) - 1;
      const nx = { ...prev };
      if (n <= 0) delete nx[id];
      else nx[id] = n;
      return nx;
    });
    boostUntil.current = Date.now() + 8000;
    setToast({ itemId: def.id, name: `${def.name} — yum! Speed boost ⚡`, rarity: def.rarity });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const onRingEvent = useCallback(
    (e: { type: "start" } | { type: "progress"; idx: number } | { type: "finish"; ms: number; best: boolean }) => {
      if (e.type === "start") setRingRun({ running: true, startedAt: Date.now(), idx: 0, finishedMs: null, best: null });
      else if (e.type === "progress") setRingRun((r) => ({ ...r, idx: e.idx }));
      else {
        setRingRun({ running: false, startedAt: 0, idx: 0, finishedMs: e.ms, best: e.ms });
        if (e.best) addItem("ring_trophy");
        setTimeout(() => setRingRun((r) => (r.running ? r : { ...r, finishedMs: null })), 6000);
      }
    },
    [addItem],
  );

  // Music: composed live in the browser; started only from a user gesture.
  const [musicVol, setMusicVol] = useState(0.7);
  const musicVolRef = useRef(0.7);
  const toggleMusic = useCallback(() => {
    setMusicVol(musicVolRef.current); // sync the slider with the restored volume
    setMusicOn((on) => {
      const next = !on;
      if (next) {
        if (!music.current) music.current = new WorldMusic();
        music.current.start(musicVolRef.current);
      } else {
        music.current?.stop();
      }
      try { localStorage.setItem("axon-world-music", next ? "1" : "0"); } catch { /* fine */ }
      return next;
    });
  }, []);
  const onMusicVol = useCallback((v: number) => {
    musicVolRef.current = v;
    setMusicVol(v);
    music.current?.setVolume(v);
    try { localStorage.setItem("axon-world-music-vol", String(v)); } catch { /* fine */ }
  }, []);
  useEffect(() => {
    // Restore saved volume (into the ref — the slider syncs when shown) and, if
    // music was on last visit, resume on the first click (autoplay rules).
    let saved = false;
    try {
      const v = Number(localStorage.getItem("axon-world-music-vol"));
      if (v > 0 && v <= 1) musicVolRef.current = v;
      saved = localStorage.getItem("axon-world-music") === "1";
    } catch { /* fine */ }
    if (!saved) return;
    const once = () => {
      if (!music.current) music.current = new WorldMusic();
      music.current.start(musicVolRef.current);
      setMusicVol(musicVolRef.current);
      setMusicOn(true);
    };
    window.addEventListener("pointerdown", once, { once: true });
    return () => window.removeEventListener("pointerdown", once);
  }, []);
  useEffect(() => () => { music.current?.stop(); }, []);

  // Wallet inventory: load on connect, merging anything a guest already won.
  const invLoaded = useRef(false);
  useEffect(() => {
    if (!wallet) { invLoaded.current = false; return; }
    let alive = true;
    fetch(`/api/world/inventory?wallet=${wallet}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items: Record<string, number> } | null) => {
        if (!alive || !d) return;
        setInv((cur) => {
          const merged = { ...d.items };
          for (const [k, v] of Object.entries(cur)) merged[k] = (merged[k] ?? 0) + v;
          return merged;
        });
        invLoaded.current = true;
      })
      .catch(() => { /* keep the session inventory */ });
    return () => { alive = false; };
  }, [wallet]);
  // …and persist it (debounced) whenever it changes.
  useEffect(() => {
    if (!wallet || !invLoaded.current) return;
    const id = setTimeout(() => {
      void fetch("/api/world/inventory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, items: inv }),
      }).catch(() => { /* cosmetic; retry next change */ });
    }, 1200);
    return () => clearTimeout(id);
  }, [inv, wallet]);

  const lowPower = useMemo(
    () => typeof navigator !== "undefined" && (navigator.hardwareConcurrency ?? 8) <= 4,
    []
  );
  // Adaptive quality ladder — the governor raises this when the machine's
  // real FPS says it's struggling (1: no post-fx + lower DPR, 2: no shadows).
  const [perfTier, setPerfTier] = useState(IS_TOUCH ? 1 : 0);

  // Boot overlay: the sky renders instantly but the town takes a couple of
  // seconds (snapshot fetch + layout) — cover the raw blue with a branded
  // loading screen that fades out the moment the buildings exist.
  const worldReady = snap !== null && buildings.length > 0;
  const [bootGone, setBootGone] = useState(false);
  useEffect(() => {
    if (!worldReady) return;
    const t = setTimeout(() => setBootGone(true), IS_TOUCH ? 2800 : 1000);
    return () => clearTimeout(t);
  }, [worldReady]);

  // Mobile: shared joystick state for the Player.
  const touchMove = useRef({ mx: 0, my: 0, run: false });
  // Phantom's in-app browser draws its own bar over the bottom edge, hiding
  // the hint chips. Detection: on touch, an injected provider = we're inside
  // the Phantom app (mobile Safari/Chrome never inject one).
  const [inPhantom, setInPhantom] = useState(false);
  useEffect(() => {
    if (!IS_TOUCH) return;
    const check = () => { if (getPhantom()) setInPhantom(true); };
    check();
    const t = setTimeout(check, 900); // providers can inject late
    return () => clearTimeout(t);
  }, []);
  const chipBottom = inPhantom ? "bottom-14" : CHIP_BOTTOM;

  const connect = async () => {
    setWalletState("connecting");
    try {
      setWallet(await connectPhantom());
      setWalletState("idle");
    } catch (e) {
      setWalletState((e as Error).message === "PHANTOM_NOT_FOUND" ? "no-phantom" : "failed");
    }
  };
  const disconnect = () => {
    void disconnectPhantom();
    setWallet(null);
    setWalletState("idle");
  };

  useEffect(() => {
    let alive = true;
    // /world?preview=1 — render the town at launch scale using the PUBLIC
    // network's real agent list (baked fixture, display-only, no DB writes).
    // Answers "how does the world look with twice the agents?" before merge.
    const preview = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("preview");
    if (preview) {
      import("./previewPlots").then(({ PREVIEW_PLOTS }) => {
        if (!alive) return;
        const plots = PREVIEW_PLOTS as unknown as WorldPlot[];
        const districts = [...new Set(plots.map((p) => p.district))];
        setSnap({
          totals: { agents: plots.length, districts: districts.length, activeAgents: plots.filter((p) => p.active).length },
          plots,
          districts: districts.map((name) => ({ name, centerX: 0, centerZ: 0 })),
          edges: [],
        });
      });
      return () => { alive = false; };
    }
    fetch("/api/world")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: WorldSnapshot) => alive && setSnap(d))
      .catch(() => { /* solo world still walkable; HUD omits counts */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/world/epoch")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: EpochSnapshot | null) => { if (alive && d) setEpoch(d); })
      .catch(() => { /* epoch board just stays hidden */ });
    return () => { alive = false; };
  }, []);

  // In the open world every building's key IS its agent id — a direct 1:1 map.
  const agentByKey = useMemo(() => {
    const m = new Map<string, WorldPlot>();
    if (snap) for (const p of snap.plots) m.set(p.agentId, p);
    return m;
  }, [snap]);

  const agentBuildings = useMemo(
    () => buildings.filter((b) => agentByKey.has(b.key)),
    [buildings, agentByKey]
  );

  // Buildings owned by the connected wallet + the spawn point beside the first.
  const mineKeys = useMemo(() => {
    const s = new Set<string>();
    if (!wallet) return s;
    for (const b of agentBuildings) {
      if (agentByKey.get(b.key)?.walletAddress === wallet) s.add(b.key);
    }
    return s;
  }, [wallet, agentBuildings, agentByKey]);

  const myAgents = useMemo(
    () => (snap && wallet ? snap.plots.filter((p) => p.walletAddress === wallet) : []),
    [snap, wallet]
  );

  // Any overlay needs the real cursor back — release the first-person pointer
  // lock while a panel is open (clicking the world afterwards re-captures it).
  const overlayOpen = Boolean(openKey || showBoard || showPipeline || showInv || showEpoch || customizing);
  useEffect(() => {
    if (overlayOpen && document.pointerLockElement) document.exitPointerLock?.();
  }, [overlayOpen]);

  // ── Wayfinding: a beam over a named agent's house until you arrive ────────
  const [waypoint, setWaypoint] = useState<{ x: number; z: number; name: string } | null>(null);
  const locateAgent = useCallback((agentId: string) => {
    const b = buildings.find((bb) => bb.key === agentId);
    const a = agentByKey.get(agentId);
    if (!b) return;
    setWaypoint({ x: b.x, z: b.z, name: a?.name ?? agentId });
    setShowBoard(false);
    setShowPipeline(false);
  }, [buildings, agentByKey]);
  const clearWaypoint = useCallback(() => setWaypoint(null), []);


  // K near a house: knock. The resident answers the door — waving hello, or
  // apologising if the agent genuinely has a task running (live activity API).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.code !== "KeyK") return;
      if (!nearestKey || knock) return;
      const agent = agentByKey.get(nearestKey);
      if (!agent) return;
      // Knock only at the FRONT — you must be near the actual door.
      const b = buildings.find((bb) => bb.key === nearestKey);
      if (b) {
        const rot = b.rot ?? 0;
        const w = b.w ?? 4;
        const doorX = b.x + Math.sin(rot) * (w / 2 + 0.6);
        const doorZ = b.z + Math.cos(rot) * (w / 2 + 0.6);
        if (Math.hypot(poseRef.current.x - doorX, poseRef.current.z - doorZ) > 4.2) return;
      }
      setKnock({ id: nearestKey, name: agent.name, busy: false });
      worldSfx.knock();
      // The busy check races the door swing — a truly working agent flips the
      // greeting to "on a job" before the resident finishes stepping out.
      fetch(`/api/world/agent/${encodeURIComponent(agent.agentId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { running: number } | null) => {
          if (d && d.running > 0) {
            setKnock((k) => (k && k.id === nearestKey ? { ...k, busy: true } : k));
          }
        })
        .catch(() => { /* stays friendly */ });
      if (knockTimer.current) clearTimeout(knockTimer.current);
      knockTimer.current = setTimeout(() => setKnock(null), 5400);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nearestKey, knock, agentByKey, buildings]);
  const knockBuilding = useMemo(
    () => (knock ? buildings.find((b) => b.key === knock.id) : undefined),
    [knock, buildings],
  );

  // Rarities of the wallet's best inventory items (rarest first) — displayed
  // as a trophy shelf outside the owner's houses.
  const trophyRarities = useMemo(() => {
    const owned = Object.entries(inv)
      .filter(([, n]) => n > 0)
      .map(([id]) => ITEMS[id])
      .filter((d): d is ItemDef => Boolean(d))
      .sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
    return owned.slice(0, 4).map((d) => d.rarity);
  }, [inv]);

  // Half-extent of the world (walk boundary + aerial scale). The world itself
  // publishes its true extent so the clamp stops you right at the treeline;
  // the plot-based estimate is only the pre-load fallback.
  const worldRadiusFallback = useMemo(
    () => (snap ? snap.plots.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.z)), 40) + 45 : 220),
    [snap]
  );
  const worldRadius = worldExtent ?? worldRadiusFallback;

  // Ring Run's start post goes exactly midway between the first two streets.
  // The walkable world lays districts at -π/2 + i·2π/N (names sorted), so the
  // midpoint at -π/2 + π/N is guaranteed open grass — never a path.
  const postAngle = useMemo(() => {
    const n = snap?.districts.length ?? 0;
    return -Math.PI / 2 + Math.PI / Math.max(1, n);
  }, [snap]);
  const postPos = useMemo<[number, number]>(
    () => [Math.cos(postAngle) * 14.5, Math.sin(postAngle) * 14.5],
    [postAngle],
  );

  // Everything solid, plus the Ring Run post itself.
  const allSolids = useMemo<Collider[]>(
    () => [...solids, { x: postPos[0], z: postPos[1], r: 0.5 }],
    [solids, postPos],
  );

  // Everyone spawns at the plaza — connecting a wallet used to warp you to
  // your own house's doorstep, which read as "why am I at a random house?".
  // Your house is one 📍 locate away if you want it.
  const spawnTo = null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") { setOpenKey(null); setCustomizing(false); setAerial(false); setShowEpoch(false); setShowInv(false); setShowBoard(false); setShowPipeline(false); setShowTerminal(false); setShowMap(false); }
      if (isTyping()) return;
      if (e.code === "KeyV" && !homeIn) setFirstPerson((p) => !p); // indoors is FP-only
      if (e.code === "KeyP") setShowPerf((v) => !v);
      if (e.code === "KeyM" && !homeIn) setAerial((m) => !m); // no sky view from indoors
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [, homeIn]);

  // Load a saved avatar + name when a wallet connects.
  useEffect(() => {
    if (!wallet) return;
    let alive = true;
    fetch(`/api/world/avatar?wallet=${wallet}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { avatar: (AvatarLook & { name?: string | null }) | null } | null) => {
        if (alive && d?.avatar) {
          setLook(d.avatar);
          if (d.avatar.name) setProfileName(d.avatar.name);
        }
      })
      .catch(() => { /* keep current look */ });
    return () => { alive = false; };
  }, [wallet]);

  // Custom name (from the character creator), falling back to wallet / Guest.
  const displayName = profileName?.trim() || (wallet ? short(wallet) : "Guest");

  const saveLook = () => {
    if (!wallet) return;
    void fetch("/api/world/avatar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, avatar: { ...look, name: displayName } }),
    }).catch(() => { /* cosmetic; ignore */ });
  };

  // Realtime presence — see other operators walking the world live. Optional:
  // if NEXT_PUBLIC_PRESENCE_URL is unset or the server is down, this stays quiet
  // and the world runs solo.
  // Earned wearables: the Ring Run crown outranks the angler's rod.
  const flair = useMemo<"none" | "crown" | "rod">(() => {
    if ((inv.ring_trophy ?? 0) > 0) return "crown";
    const fishy = ["minnow", "perch", "carp", "bass", "catfish", "golden_koi", "golden_fish"];
    return fishy.some((id) => (inv[id] ?? 0) > 0) ? "rod" : "none";
  }, [inv]);
  const lookWorn = useMemo<AvatarLook>(() => ({ ...look, flair }), [look, flair]);
  const self = useMemo(() => ({ name: displayName, look: lookWorn }), [displayName, lookWorn]);
  // A gift from a nearby player: validate the item locally, pocket it, thank them.
  const onGiftReceived = useCallback((_from: string, name: string, item: string) => {
    const def = ITEMS[item];
    if (!def) return;
    worldSfx.chest();
    setInv((prev) => ({ ...prev, [item]: (prev[item] ?? 0) + 1 }));
    setToast({ itemId: item, name: `${def.name} — a gift from ${name}!`, rarity: def.rarity });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  const poseRef = useRef<PeerPose>({ x: 0, z: 18, ry: Math.PI, st: "idle" });
  const { connected, selfId, peerList, posesRef, bubblesRef, chatLog, count, sendPose, sendChat, sendEmote, sendGift } =
    usePresence(process.env.NEXT_PUBLIC_PRESENCE_URL, self, onGiftReceived);
  const [nearPeer, setNearPeer] = useState<{ id: string; name: string } | null>(null);
  const peerListRef = useRef(peerList);
  useEffect(() => { peerListRef.current = peerList; }, [peerList]);
  const solidsRefForNpc = useRef<Collider[]>([]);
  useEffect(() => { solidsRefForNpc.current = solids; }, [solids]);
  // Hand an item to the player beside you — trust-based (cosmetics only).
  const giveItem = useCallback((id: string) => {
    const to = nearPeer;
    const def = ITEMS[id];
    // Guard on the CURRENT count before sending — otherwise a double-click on
    // the last item sends two gifts while only one leaves the bag.
    if (!to || !def || (inv[id] ?? 0) <= 0) return;
    setInv((prev) => {
      const n = prev[id] ?? 0;
      if (n <= 0) return prev;
      const nx = { ...prev };
      if (n - 1 <= 0) delete nx[id];
      else nx[id] = n - 1;
      return nx;
    });
    sendGift(to.id, id);
    worldSfx.pick();
    setToast({ itemId: id, name: `${def.name} → sent to ${to.name}`, rarity: def.rarity });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, [nearPeer, sendGift, inv]);
  useEffect(() => {
    const id = setInterval(() => sendPose(poseRef.current), 100);
    return () => clearInterval(id);
  }, [sendPose]);

  // Position of each agent's house, keyed by agentId — for neighbor roads + map.
  const posByAgentId = useMemo(() => {
    const m = new Map<string, { x: number; z: number }>();
    for (const b of agentBuildings) {
      const a = agentByKey.get(b.key);
      if (a) m.set(a.agentId, { x: b.x, z: b.z });
    }
    return m;
  }, [agentBuildings, agentByKey]);

  const myAgentIds = useMemo(() => new Set(myAgents.map((a) => a.agentId)), [myAgents]);

  // Crown floats over this epoch's #1 agent, if their house is in the village.
  const crownPos = useMemo<[number, number, number] | null>(() => {
    const top = epoch?.leaderboard[0];
    if (!top) return null;
    const p = posByAgentId.get(top.agentId);
    return p ? [p.x, 0, p.z] : null;
  }, [epoch, posByAgentId]);

  // Chat input.
  const [chatInput, setChatInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chatLog]);
  const onSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const t = chatInput.trim();
    if (t) { sendChat(t); setChatInput(""); }
  };

  const nearestAgent = nearestKey ? agentByKey.get(nearestKey) : undefined;
  const openAgent = openKey ? agentByKey.get(openKey) : undefined;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#8eccf2]">
      <Canvas
        shadows
        dpr={[1, lowPower ? 1 : 1.1]}
        // antialias off: SMAA in the post chain already does AA (the composer
        // even sets multisampling=0 for the same reason) — the canvas MSAA
        // buffer is redundant fill + memory.
        gl={{ powerPreference: "high-performance", antialias: false }}
        camera={{ position: [0, 8, 34], fov: 55 }}
      >
        <WorldEnvironment lowPower={lowPower} sea={false} shadowExtent={90} ao={false} shadowFollowRef={poseRef} perfTier={IS_TOUCH ? 2 : perfTier} />
        <QualityGovernor onTier={setPerfTier} />
        <WarmUp ready={worldReady} />
        {snap && (
          <OpenWorld
            plots={snap.plots}
            lowPower={lowPower}
            onSolids={setSolids}
            onBuildings={setBuildings}
            onFishSpots={setFishSpots}
            onBenches={setBenches}
            onGatherSpots={setGatherSpots}
            onBouncePads={setBouncePads}
            bounceFxRef={bounceFx}
            onExtent={setWorldExtent}
            playerPosRef={poseRef}
            animalsRef={animalsRef}
            onHenCaught={onHenCaught}
            onNearPet={setNearPet}
            trophyIds={mineKeys}
            trophyRarities={trophyRarities}
            onChests={setChestSpots}
            openedChestIds={openedChests}
            knockId={knock?.id ?? null}
            onBoard={setBoardSpot}
            bidderIds={bidderIds}
            onDesk={setDeskSpot}
            stallStaff={snap.weeklyTop}
            onMapBoard={setMapSpot}
            onLandmarks={setLandmarks}
          />
        )}
        {!homeIn && <TaskStreaks buildings={buildings} />}
        {crownPos && <Crown position={crownPos} />}
        {knock && knockBuilding && (
          <DoorGreeterFigure key={knock.id} b={knockBuilding} busy={knock.busy} name={knock.name} />
        )}
        <group name="villagers">
          {BOTS.slice(0, activeBots).map((b, i) => (
            <Villager key={b.seed} seed={b.seed} name={b.name} slot={i} start={b.start} worldRadius={worldRadius} solidsRef={solidsRefForNpc} playerRef={poseRef} />
          ))}
        </group>
        <Beacons buildings={agentBuildings} nearestKey={nearestKey} mineKeys={mineKeys} poseRef={poseRef} />
        <group name="peers"><Peers peerList={peerList} posesRef={posesRef} bubblesRef={bubblesRef} playerRef={poseRef} /></group>
        <FishingManager spots={fishSpots} poseRef={poseRef} cancelRef={fishCancel} onCatch={onCatch} onPrompt={setFishPrompt} onState={setFishingSpot} />
        <GatherManager spots={gatherSpots} poseRef={poseRef} onGather={onGather} onNear={setNearGather} />
        <ChestManager spots={chestSpots} openedRef={openedChestsRef} poseRef={poseRef} onOpen={openGiftChest} onNear={setNearChest} />
        <BoardManager spot={boardSpot} poseRef={poseRef} onOpen={openBoard} onNear={setNearBoard} />
        <BoardManager spot={mapSpot} poseRef={poseRef} onOpen={openMap} onNear={setNearMapBoard} />
        <NearDoorManager poseRef={poseRef} nearestKeyRef={nearestKeyRef} buildingsRef={buildingsRefHud} onNear={setNearDoorFront} />
        {showPerf && <StatsProbe onStats={setPerf} />}
        <BoardManager spot={deskSpot} poseRef={poseRef} onOpen={openPipeline} onNear={setNearDesk} />
        <NearPeerManager posesRef={posesRef} poseRef={poseRef} peersRef={peerListRef} onNear={setNearPeer} />
        {waypoint && !homeIn && <WaypointBeacon x={waypoint.x} z={waypoint.z} poseRef={poseRef} onArrive={clearWaypoint} />}
        {homeIn && (
          <>
            <HomeInterior agentId={homeIn.agentId} name={homeIn.name} rarities={trophyRarities} />
            <BoardManager
              spot={{ x: INTERIOR_POS.x, z: INTERIOR_POS.z + 5.4 }}
              poseRef={poseRef}
              onOpen={exitHome}
              onNear={setNearExit}
            />
            <BoardManager
              spot={{ x: INTERIOR_POS.x + 3.7, z: INTERIOR_POS.z - 3.2 }}
              poseRef={poseRef}
              onOpen={openTerminal}
              onNear={setNearTerminal}
            />
            <BoardManager
              spot={{ x: INTERIOR_POS.x - 1.5, z: INTERIOR_POS.z - 3.6 }}
              poseRef={poseRef}
              onOpen={restInBed}
              onNear={setNearBed}
            />
          </>
        )}
        {snap && <RingRun postAngle={postAngle} poseRef={poseRef} obstacles={allSolids} onEvent={onRingEvent} />}
        <Player
          solids={allSolids}
          buildings={agentBuildings}
          benches={benches}
          animalsRef={animalsRef}
          boostRef={boostUntil}
          bouncePads={bouncePads}
          bounceFxRef={bounceFx}
          fishingSpot={fishingSpot}
          onFishMove={onFishMove}
          onNearest={setNearestKey}
          onInteract={onInteractBuilding}
          onNearBench={setNearBench}
          onSitting={setSitting}
          spawnTo={warp ?? spawnTo}
          interior={homeIn != null}
          restRef={restRef}
          onRestEnd={onRestEnd}
          perfTier={perfTier}
          touchRef={touchMove}
          look={lookWorn}
          firstPerson={firstPerson}
          name={displayName}
          poseRef={poseRef}
          peersRef={posesRef}
          bubblesRef={bubblesRef}
          selfId={selfId}
          aerial={aerial}
          worldRadius={worldRadius}
          lowPower={lowPower}
        />
      </Canvas>

      {!snap && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="rounded-full bg-black/55 text-white text-sm px-5 py-2">Loading the world…</div>
        </div>
      )}

      {/* World stats — agents + districts only (population lives in the pill).
          Touch screens get one tiny line; the big card crowded the pill. */}
      {IS_TOUCH ? (
        <div className="absolute top-3 left-3 rounded-lg bg-white/80 backdrop-blur px-2.5 py-1 shadow leading-tight">
          <p className="text-[9px] font-mono text-emerald-700 font-bold">AXON · {snap ? `${snap.totals.agents} agents` : "…"}</p>
          {snap && <p className="text-[9px] font-mono text-emerald-700/80">{snap.totals.districts} districts</p>}
        </div>
      ) : (
        <div className="absolute top-4 left-4 rounded-xl bg-white/85 backdrop-blur px-4 py-3 shadow-lg">
          <p className="text-xs tracking-widest text-emerald-600 font-mono">AXON WORLD</p>
          {snap ? (
            <p className="text-sm text-gray-700">
              {snap.totals.agents} agents · {snap.totals.districts} districts
            </p>
          ) : (
            <p className="text-sm text-gray-500">Walk in and explore</p>
          )}
        </div>
      )}

      {showPerf && perf && (
        <div className="absolute bottom-4 right-4 rounded-lg bg-black/80 text-emerald-300 font-mono text-[11px] px-3 py-2 shadow-lg z-30 max-w-[260px]">
          <p>{perf.fps} fps · {perf.calls} calls · {(perf.tris / 1000).toFixed(0)}k tris</p>
          {perf.census.map((line) => (
            <p key={line} className="text-emerald-500/80">{line}</p>
          ))}
        </div>
      )}

      {/* Chat + live presence (desktop — on touch the joystick owns that corner) */}
      {connected && !IS_TOUCH && (
        <div className="absolute bottom-4 left-4 w-72 rounded-xl bg-white/90 backdrop-blur shadow-lg flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
            <span className="text-xs font-mono text-emerald-600">Chat</span>
            <span className="text-[11px] text-gray-400 truncate ml-2">{displayName} (you)</span>
          </div>
          <div ref={logRef} className="px-3 py-2 h-28 overflow-auto text-sm space-y-0.5">
            {chatLog.length === 0 ? (
              <p className="text-gray-400 text-xs">Say hi to the network 👋</p>
            ) : (
              chatLog.map((l) => (
                <p key={l.key} className="leading-snug">
                  <span className="font-semibold text-gray-800 font-mono text-xs">{l.name}:</span>{" "}
                  <span className="text-gray-700">{l.text}</span>
                </p>
              ))
            )}
          </div>
          <div className="px-2 pt-1 flex gap-1 justify-center">
            {EMOTE_KEYS.map((e) => (
              <button key={e} onClick={() => sendEmote(e)} className="text-lg hover:scale-125 transition-transform" title={e}>
                {EMOTE_GLYPH[e]}
              </button>
            ))}
          </div>
          <form onSubmit={onSendChat} className="p-2 flex gap-1">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Say something…"
              maxLength={200}
              className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <button type="submit" className="rounded-md bg-emerald-600 text-white px-3 text-sm font-semibold hover:bg-emerald-500">Send</button>
          </form>
        </div>
      )}

      {/* Your district — desktop only (covered the whole screen on phones) */}
      {wallet && !IS_TOUCH && (
        <div className="absolute top-24 left-4 w-64 rounded-xl bg-white/90 backdrop-blur px-4 py-3 shadow-lg">
          <div className="flex items-center justify-between">
            <p className="text-xs tracking-widest text-teal-600 font-mono">YOUR DISTRICT</p>
            <button onClick={disconnect} className="text-[11px] text-gray-400 hover:text-gray-600">disconnect</button>
          </div>
          {myAgents.length ? (
            <ul className="mt-2 space-y-1.5 max-h-56 overflow-auto">
              {myAgents.map((a) => (
                <li key={a.agentId} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-800 truncate">{a.name}</span>
                  <span className="text-xs text-gray-500 whitespace-nowrap">${a.usdcEarned.toFixed(0)} · {a.tasksCompleted}✓</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-gray-500">
              No agents on this wallet yet — you&apos;re in the town square. Register an agent and it&apos;ll appear here.
            </p>
          )}
        </div>
      )}

      {/* Contextual prompt / controls hint — most urgent first */}
      {fishPrompt === "bite" ? (
        <div className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-rose-600 text-white text-base px-6 py-3 shadow-lg font-bold animate-pulse`}>
          ‼️ BITE — press <span className="font-mono">E</span>!
        </div>
      ) : fishPrompt === "wait" ? (
        <div className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-sky-700/90 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          🎣 Waiting for a bite… (walk away to stop)
        </div>
      ) : sitting ? (
        <div className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-black/55 text-white text-xs px-4 py-2`}>
          {IS_TOUCH ? "Sitting — move the stick to stand up" : "Sitting — any move key to stand up"}
        </div>
      ) : fishPrompt === "cast" ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-sky-600 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          🎣 {IS_TOUCH ? "Tap to fish" : <>Press <span className="font-mono">E</span> to fish</>}
        </button>
      ) : nearBench ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-amber-600 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          🪑 {IS_TOUCH ? "Tap to sit" : <>Press <span className="font-mono">E</span> to sit</>}
        </button>
      ) : nearTerminal && homeIn && !showTerminal ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-teal-700 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          💻 {IS_TOUCH ? "Tap — agent terminal" : <>Press <span className="font-mono">E</span> — agent terminal</>}
        </button>
      ) : nearBed && homeIn ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-indigo-800 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          🛏 {IS_TOUCH ? "Tap to rest" : <>Press <span className="font-mono">E</span> to rest</>}
        </button>
      ) : nearExit && homeIn ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-amber-700 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          🏠 {IS_TOUCH ? "Tap to step outside" : <>Press <span className="font-mono">E</span> to step outside</>}
        </button>
      ) : nearDesk && !showPipeline ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-indigo-700 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          ▤ {IS_TOUCH ? "Tap — Pipeline Desk" : <>Press <span className="font-mono">E</span> — Pipeline Desk</>}
          {orderSteps && orderSteps.length > 0 ? ` (${orderSteps.length} step${orderSteps.length > 1 ? "s" : ""} ready)` : ""}
        </button>
      ) : nearMapBoard && !showMap ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-emerald-700 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          🗺 {IS_TOUCH ? "Tap — world map" : <>Press <span className="font-mono">E</span> — world map</>}
        </button>
      ) : nearBoard && !showBoard ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-amber-700 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          ▤ {IS_TOUCH ? "Tap to read the job board" : <>Press <span className="font-mono">E</span> to read the job board</>}
        </button>
      ) : nearChest ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-yellow-600 text-white text-sm px-5 py-2.5 shadow-lg font-semibold flex items-center gap-2`}>
          <ItemIcon id="gift_chest" size={18} />
          {giftCapReached ? (
            <span>Daily gifts all opened — come back tomorrow!</span>
          ) : IS_TOUCH ? (
            <span>Tap to open the gift chest</span>
          ) : (
            <span>Press <span className="font-mono">E</span> to open the gift chest</span>
          )}
        </button>
      ) : nearGather ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-lime-600 text-white text-sm px-5 py-2.5 shadow-lg font-semibold flex items-center gap-2`}>
          {nearGather === "apple" ? <ItemIcon id="apple" size={18} /> : nearGather === "berry" ? <ItemIcon id="berries" size={18} /> : <span>⛏</span>}
          <span>
            {IS_TOUCH ? "Tap" : <>Press <span className="font-mono">E</span></>}
            {nearGather === "apple" ? " to pick apples" : nearGather === "berry" ? " to pick berries" : " to dig"}
          </span>
        </button>
      ) : nearPet ? (
        <button onClick={() => pressKey("KeyE")} className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-pink-500 text-white text-sm px-5 py-2.5 shadow-lg font-semibold`}>
          🐾 {IS_TOUCH ? "Tap to pet" : <>Press <span className="font-mono">E</span> to pet</>}
        </button>
      ) : nearestAgent && !openAgent ? (
        <button
          onClick={() => nearestKey && setOpenKey(nearestKey)}
          className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-emerald-600 text-white text-sm px-5 py-2.5 shadow-lg font-semibold hover:bg-emerald-500`}
        >
          {IS_TOUCH ? (
            <>▸ {nearestAgent.name} · tap to view{nearDoorFront ? " · KNOCK button to knock" : ""}</>
          ) : (
            <>
              ▸ {nearestAgent.name} · <span className="font-mono">E</span> view
              {nearDoorFront && (
                <>
                  {" "}· <span className="font-mono">K</span> knock
                </>
              )}
            </>
          )}
        </button>
      ) : IS_TOUCH ? (
        <div className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-black/55 text-white text-xs px-4 py-2 text-center`}>
          <span className="font-semibold">Stick</span> to walk · <span className="font-semibold">drag</span> to look
        </div>
      ) : (
        <div className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-black/55 text-white text-xs px-4 py-2 text-center`}>
          <span className="font-semibold">WASD</span> move · <span className="font-semibold">Shift</span> run · <span className="font-semibold">Space</span> jump · <span className="font-semibold">V</span> view · <span className="font-semibold">M</span> sky
        </div>
      )}

      {/* Loot toast */}
      {toast && (
        <div
          className="absolute top-20 left-1/2 -translate-x-1/2 rounded-xl bg-white/95 backdrop-blur px-5 py-3 shadow-xl border-2 flex items-center gap-3"
          style={{ borderColor: RARITY_COLOR[toast.rarity] }}
        >
          <ItemIcon id={toast.itemId} size={30} />
          <div>
            <p className="text-sm font-bold text-gray-800">{toast.name}</p>
            <p className="text-[11px] font-semibold" style={{ color: RARITY_COLOR[toast.rarity] }}>
              {RARITY_LABEL[toast.rarity]} · added to inventory
            </p>
          </div>
        </div>
      )}

      {/* Ring Run status */}
      {ringRun.running && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 rounded-full bg-teal-600/95 text-white text-sm px-5 py-2 shadow-lg font-semibold font-mono">
          🏁 Ring {ringRun.idx + 1}/10 · <RingTimer startedAt={ringRun.startedAt} />
        </div>
      )}
      {!ringRun.running && ringRun.finishedMs !== null && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 rounded-full bg-teal-700/95 text-white text-sm px-5 py-2 shadow-lg font-semibold font-mono">
          🏁 {(ringRun.finishedMs / 1000).toFixed(2)}s!
        </div>
      )}

      {/* Boot screen — fades as soon as the town is built */}
      {!bootGone && (
        <div
          className={`absolute inset-0 z-40 bg-[#0b0f14] flex flex-col items-center justify-center gap-4 transition-opacity duration-700 ${worldReady ? "opacity-0 pointer-events-none" : "opacity-100"}`}
        >
          <p className="text-teal-400 font-mono tracking-[0.4em] text-sm">AXON WORLD</p>
          <div className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="w-2 h-2 rounded-full bg-teal-400 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </div>
          <p className="text-gray-500 text-xs">building the town from the live network…</p>
        </div>
      )}

      {/* Mobile controls — portrait and landscape both welcome */}
      {IS_TOUCH && <TouchControls touchRef={touchMove} />}

      {/* Live population — players + residents, front and centre */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-white/85 backdrop-blur px-4 py-2 text-sm font-semibold text-gray-800 shadow-lg flex items-center gap-1.5" title="Explorers in the world right now (players + residents)">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        {count + activeBots} in world
      </div>

      <div className="absolute top-4 right-4 flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          {/* Wallet lives in the menu on touch — the top bar is too tight there */}
          {!IS_TOUCH &&
            (wallet ? (
              <span className="rounded-full bg-teal-600 text-white px-4 py-2 text-sm font-semibold shadow-lg font-mono">
                {short(wallet)}
              </span>
            ) : (
              <button
                onClick={connect}
                disabled={walletState === "connecting"}
                className="rounded-full bg-teal-600 text-white px-4 py-2 text-sm font-semibold shadow-lg hover:bg-teal-500 disabled:opacity-70"
              >
                {walletState === "connecting" ? "Connecting…" : "Connect wallet"}
              </button>
            ))}
          <button
            onClick={() => setShowMenu((m) => !m)}
            className={`rounded-full backdrop-blur px-4 py-2 text-sm font-semibold shadow-lg ${showMenu ? "bg-teal-600 text-white" : "bg-white/85 text-gray-800 hover:bg-white"}`}
          >
            ☰ Menu
          </button>
        </div>
        {showMenu && (
          <div className="flex flex-col items-stretch gap-1.5 rounded-2xl bg-white/90 backdrop-blur p-2 shadow-xl">
            <div className={`flex items-center rounded-xl ${musicOn ? "bg-teal-600" : "bg-gray-100"}`}>
              <button
                onClick={toggleMusic}
                className={`px-3 py-2 text-sm font-semibold flex-1 text-left ${musicOn ? "text-white" : "text-gray-800"}`}
              >
                {musicOn ? "🔊 Music" : "🔇 Music"}
              </button>
              {musicOn && (
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(musicVol * 100)}
                  onChange={(e) => onMusicVol(Number(e.target.value) / 100)}
                  className="w-20 mr-3 accent-white cursor-pointer"
                  title="Volume"
                />
              )}
            </div>
            <button onClick={toggleSfx} className={`px-3 py-2 text-sm font-semibold text-left rounded-xl ${sfxOn ? "bg-gray-100 text-gray-800" : "bg-gray-100/60 text-gray-400"}`}>
              {sfxOn ? "🔔 SFX on" : "🔕 SFX off"}
            </button>
            <button onClick={() => { setShowInv((v) => !v); setShowMenu(false); }} className="px-3 py-2 text-sm font-semibold text-left rounded-xl bg-gray-100 text-gray-800 hover:bg-gray-200">
              🎒 Inventory
            </button>
            {epoch && (
              <button onClick={() => { setShowEpoch((v) => !v); setShowMenu(false); }} className="px-3 py-2 text-sm font-semibold text-left rounded-xl bg-gray-100 text-gray-800 hover:bg-gray-200">
                🏆 Epoch
              </button>
            )}
            {/* No sky view from indoors — the character is clamped in the tiny
                interior box, so aerial would strand the camera outside it. */}
            {!homeIn && (
              <button onClick={() => { setAerial((m) => !m); setShowMenu(false); }} className={`px-3 py-2 text-sm font-semibold text-left rounded-xl ${aerial ? "bg-teal-600 text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"}`}>
                {aerial ? "↩ Back down" : "🛰 Sky view"}
              </button>
            )}
            {wallet && (
              <button onClick={() => { setCustomizing((c) => !c); setShowMenu(false); }} className="px-3 py-2 text-sm font-semibold text-left rounded-xl bg-gray-100 text-gray-800 hover:bg-gray-200">
                🎨 Customize
              </button>
            )}
            {IS_TOUCH && !wallet && (
              <button
                onClick={() => { void connect(); setShowMenu(false); }}
                className="px-3 py-2 text-sm font-semibold text-left rounded-xl bg-teal-600 text-white"
              >
                👛 {walletState === "connecting" ? "Connecting…" : "Connect wallet"}
              </button>
            )}
            {IS_TOUCH && wallet && (
              <button
                onClick={() => { disconnect(); setShowMenu(false); }}
                className="px-3 py-2 text-sm font-semibold text-left rounded-xl bg-gray-100 text-gray-800"
              >
                👛 {short(wallet)} · disconnect
              </button>
            )}
            <button
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen?.();
                else void document.documentElement.requestFullscreen?.().catch(() => {});
                setShowMenu(false);
              }}
              className="px-3 py-2 text-sm font-semibold text-left rounded-xl bg-gray-100 text-gray-800 hover:bg-gray-200"
            >
              ⛶ Fullscreen
            </button>
            <button onClick={onExit} className="px-3 py-2 text-sm font-semibold text-left rounded-xl bg-gray-100 text-gray-800 hover:bg-gray-200">
              ← Exit
            </button>
          </div>
        )}
      </div>

      {/* Wallet errors */}
      {walletState === "no-phantom" && (
        <div className="absolute top-16 right-4 w-64 rounded-lg bg-white/95 px-4 py-3 shadow-lg text-sm text-gray-700">
          Phantom wallet not found.{" "}
          <a href="https://phantom.app/" target="_blank" rel="noreferrer" className="text-teal-600 underline">Install it</a>{" "}
          to see your agents.
        </div>
      )}
      {walletState === "failed" && (
        <div className="absolute top-16 right-4 w-64 rounded-lg bg-white/95 px-4 py-3 shadow-lg text-sm text-gray-700">
          Couldn&apos;t connect. Try again.
        </div>
      )}

      {customizing && wallet && (
        <CreateCharacter
          look={look}
          setLook={setLook}
          name={profileName ?? (wallet ? short(wallet) : "Guest")}
          setName={setProfileName}
          onSave={saveLook}
          onClose={() => setCustomizing(false)}
        />
      )}

      {showEpoch && epoch && (
        <EpochPanel epoch={epoch} myAgentIds={myAgentIds} rewardsEnabled={rewardsEnabled} onClose={() => setShowEpoch(false)} />
      )}

      {showInv && <InventoryPanel inv={inv} wallet={wallet} giftTo={nearPeer} onGift={giveItem} onClose={() => setShowInv(false)} onEat={eatItem} />}

      {openAgent && (
        <AgentCard
          key={openAgent.agentId}
          agent={openAgent}
          mine={wallet != null && openAgent.walletAddress === wallet}
          orderSteps={pipelineRun ? null : orderSteps}
          onAddStep={addOrderStep}
          onEnterHome={enterHome}
          onClose={() => setOpenKey(null)}
        />
      )}
      {showBoard && <BidBoardPanel names={agentByKey} onLocate={locateAgent} onClose={() => setShowBoard(false)} />}
      {showMap && (
        <MapPanel
          buildings={buildings}
          agentByKey={agentByKey}
          landmarks={landmarks}
          poseRef={poseRef}
          extent={worldRadius}
          onLocate={(x, z, name) => setWaypoint({ x, z, name })}
          onClose={() => setShowMap(false)}
        />
      )}
      {showTerminal && homeIn && (
        <TerminalPanel
          agentId={homeIn.agentId}
          name={homeIn.name}
          plot={agentByKey.get(homeIn.agentId) ?? null}
          onClose={() => setShowTerminal(false)}
        />
      )}
      {resting && (
        <div className={`absolute ${chipBottom} left-1/2 -translate-x-1/2 rounded-full bg-black/55 text-white text-xs px-4 py-2 z-30`}>
          💤 {IS_TOUCH ? "Resting — move the stick to get up" : "Resting — any move key to get up"}
        </div>
      )}
      {showPipeline && (
        <PipelinePanel
          steps={orderSteps ?? []}
          names={agentByKey}
          run={pipelineRun}
          onRemoveLast={() => setOrderSteps((s) => (s ?? []).slice(0, -1))}
          onReset={resetPipeline}
          onRun={runPipeline}
          onLocate={locateAgent}
          onClose={() => setShowPipeline(false)}
        />
      )}
      {waypoint && (
        <button
          onClick={clearWaypoint}
          className="absolute top-28 left-1/2 -translate-x-1/2 rounded-full bg-teal-700/95 text-white text-xs px-4 py-2 shadow-lg font-semibold hover:bg-teal-600"
        >
          📍 Following the light to {waypoint.name} — click to stop
        </button>
      )}
      {orderSteps !== null && orderSteps.length > 0 && !showPipeline && !pipelineRun && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 rounded-full bg-indigo-700/95 text-white text-xs px-4 py-2 shadow-lg font-semibold">
          Work order · {orderSteps.map((id) => agentByKey.get(id)?.name ?? id).join(" → ")} · run it at the Pipeline Desk
        </div>
      )}
      {pipelineRun && pipelineRun.status === "running" && !showPipeline && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 rounded-full bg-indigo-700/95 text-white text-xs px-4 py-2 shadow-lg font-semibold animate-pulse">
          Pipeline running — step {Math.min(pipelineRun.currentStep + 1, pipelineRun.agents.length)}/{pipelineRun.agents.length}
        </div>
      )}
      {pipelineRun && pipelineRun.status !== "running" && !showPipeline && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 rounded-full bg-emerald-700/95 text-white text-xs px-4 py-2 shadow-lg font-semibold">
          Pipeline {pipelineRun.status} — read the result at the Pipeline Desk
        </div>
      )}
    </div>
  );
}
