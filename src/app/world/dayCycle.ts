// The world clock — one full day every 20 minutes, shared by the sky
// (Landing), the world props that react to darkness (OpenWorld) and the N-key
// time skip (World3D). Lives in its own module so none of those import each
// other for it.

export const DAY_CYCLE_S = 1200;
let daySkew = 0.63 * DAY_CYCLE_S;

/**
 * 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
 *
 * Anchored to WALL-CLOCK time, not scene time: the world is multiplayer, and
 * two players standing together must see the same sky. Every client on Earth
 * derives the identical phase, and it survives reloads. (The elapsed param is
 * kept so useFrame call sites don't need churn — it's intentionally unused.)
 */
export function dayPhase(_elapsed?: number): number {
  return ((Date.now() / 1000 + daySkew) / DAY_CYCLE_S) % 1;
}

/** Jump forward an eighth of a day — local-only preview (shifts this client). */
export function skipDayTime(): void {
  daySkew += DAY_CYCLE_S / 8;
}

// ── Arena mood override ───────────────────────────────────────────────────────
// Zombie Waves belongs at night: torches, silhouettes, a horizon ember. Like the
// N-key skip this is a LOCAL preview — this client's sky only — and it restores
// the shared wall-clock phase the moment the arena is left.
let savedSkew: number | null = null;

/** Pin the local sky to a phase (0 midnight … 0.5 noon) until cleared. */
export function overridePhase(target: number): void {
  if (savedSkew === null) savedSkew = daySkew;
  daySkew = target * DAY_CYCLE_S - Date.now() / 1000;
}

/** Back to the shared, wall-clock-anchored sky. */
export function clearPhaseOverride(): void {
  if (savedSkew !== null) {
    daySkew = savedSkew;
    savedSkew = null;
  }
}

/** How deep into night we are, 0 (day) → 1 (full night). */
export function nightFactor(elapsed?: number): number {
  const p = dayPhase(elapsed);
  const sunY = Math.sin((p - 0.25) * Math.PI * 2);
  return Math.max(0, Math.min(1, -sunY * 2 + 0.25));
}
