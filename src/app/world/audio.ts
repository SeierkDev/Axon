// Phase 10: generative ambient music for Axon World.
//
// No audio files — a calm, seamless loop composed live with the Web Audio API:
// warm pad chords (Am7 → Fmaj7 → Cmaj7 → G6), a soft sine bass, and sparse
// pentatonic plucks over a feedback-delay "space". Started only from a user
// gesture (browser autoplay rules); fades in/out gently.

const BAR_S = 4.8; // one chord per bar
const LOOKAHEAD_MS = 200;
const SCHEDULE_AHEAD_S = 1.2;

// Chord voicings (Hz) — mellow, mid-register.
const CHORDS: number[][] = [
  [220.0, 261.63, 329.63, 392.0], // Am7
  [174.61, 220.0, 261.63, 329.63], // Fmaj7
  [196.0, 261.63, 329.63, 392.0], // Cmaj7/G
  [196.0, 246.94, 293.66, 440.0], // G6add9
];
const BASS: number[] = [110.0, 87.31, 130.81, 98.0]; // A2 F2 C3 G2
// A-minor pentatonic for the melody plucks.
const PENTA: number[] = [440.0, 523.25, 587.33, 659.25, 783.99, 880.0];

const MAX_GAIN = 0.7;

export class WorldMusic {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBarTime = 0;
  private bar = 0;
  private vol = 0.7; // 0..1 user volume, scales MAX_GAIN
  // One AudioContext for the class's whole life: stop() SUSPENDS instead of
  // closing, start() resumes. Browsers cap live contexts per tab (~6) — arena
  // enter/leave used to churn new ones against deferred closes.
  private active = false;

  get playing(): boolean {
    return this.active;
  }

  // User volume (0..1) — applied smoothly if already playing, remembered if not.
  setVolume(v: number): void {
    this.vol = Math.max(0, Math.min(1, v));
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(Math.max(0.0001, MAX_GAIN * this.vol), this.ctx.currentTime, 0.12);
    }
  }

  start(volume?: number): void {
    if (volume !== undefined) this.vol = Math.max(0, Math.min(1, volume));
    if (this.active) return;
    if (this.ctx && this.master) {
      // resume the suspended context and refade — no new context, no churn
      this.active = true;
      void this.ctx.resume();
      const t0 = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t0);
      this.master.gain.setValueAtTime(0.0001, t0);
      this.master.gain.exponentialRampToValueAtTime(Math.max(0.0001, MAX_GAIN * this.vol), t0 + 2.5);
      this.bar = 0;
      this.nextBarTime = t0 + 0.15;
      if (!this.timer) this.timer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
      this.schedule();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.active = true;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(Math.max(0.0001, MAX_GAIN * this.vol), ctx.currentTime + 2.5); // gentle fade-in
    master.connect(ctx.destination);
    this.master = master;

    // A feedback delay gives the plucks and pads a soft sense of space.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.31;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.28;
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(master);
    // Everything routes through `bus` → master (+ delay send).
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(master);
    bus.connect(delay);
    this.bus = bus;

    this.bar = 0;
    this.nextBarTime = ctx.currentTime + 0.15;
    this.timer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
    this.schedule();
  }

  private bus: GainNode | null = null;

  private schedule(): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    while (this.nextBarTime < ctx.currentTime + SCHEDULE_AHEAD_S) {
      this.scheduleBar(ctx, bus, this.nextBarTime, this.bar);
      this.nextBarTime += BAR_S;
      this.bar++;
    }
  }

  private scheduleBar(ctx: AudioContext, out: GainNode, t: number, bar: number): void {
    const chord = CHORDS[bar % CHORDS.length];

    // Pad — slow-attack triangle voices through a mellow lowpass.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 850;
    lp.Q.value = 0.4;
    lp.connect(out);
    for (const f of chord) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      osc.detune.value = (Math.random() - 0.5) * 7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.055, t + 1.4);
      g.gain.setValueAtTime(0.055, t + BAR_S - 1.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + BAR_S + 0.4);
      osc.connect(g);
      g.connect(lp);
      osc.start(t);
      osc.stop(t + BAR_S + 0.6);
    }

    // Bass — one soft sine root note per bar.
    const bass = ctx.createOscillator();
    bass.type = "sine";
    bass.frequency.value = BASS[bar % BASS.length];
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.08, t + 0.5);
    bg.gain.setValueAtTime(0.08, t + BAR_S - 1.2);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + BAR_S + 0.2);
    bass.connect(bg);
    bg.connect(out);
    bass.start(t);
    bass.stop(t + BAR_S + 0.4);

    // Sparse plucked melody — 0–2 pentatonic notes per bar, never on bar 1 of
    // the loop so the progression gets room to breathe.
    const plucks = bar % CHORDS.length === 0 ? Math.floor(Math.random() * 2) : Math.floor(Math.random() * 3);
    for (let i = 0; i < plucks; i++) {
      const when = t + 0.4 + Math.random() * (BAR_S - 1.4);
      const freq = PENTA[Math.floor(Math.random() * PENTA.length)];
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.05, when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.9);
      osc.connect(g);
      g.connect(out);
      osc.start(when);
      osc.stop(when + 1);
    }
  }

  stop(): void {
    const ctx = this.ctx;
    if (!ctx || !this.active) return;
    this.active = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const master = this.master;
    if (master) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
    }
    // after the fade: SUSPEND (keep the context for reuse) — unless a restart won
    setTimeout(() => { if (!this.active) void ctx.suspend().catch(() => { /* closing */ }); }, 1000);
  }
}

// ── Sound effects ─────────────────────────────────────────────────────────────
//
// Synthesized one-shots, same philosophy as the music: no audio files, tiny,
// warm. Own lazy AudioContext (created on the first user-gesture-driven call,
// so autoplay rules are satisfied — key presses count). A master gain keeps
// everything quiet relative to the music; a toggle mutes the lot.

class WorldSfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private on = true;

  setEnabled(v: boolean): void {
    this.on = v;
  }
  get enabled(): boolean {
    return this.on;
  }

  private ensure(): AudioContext | null {
    if (!this.on) return null;
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  // A pitched blip: oscillator with a fast attack/decay envelope.
  private tone(freq: number, dur: number, peak: number, type: OscillatorType = "sine", freqEnd?: number, delay = 0): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // A filtered noise burst — taps, steps, splashes.
  private burst(dur: number, peak: number, filterType: BiquadFilterType, freq: number, freqEnd?: number, delay = 0): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(10, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  /** Two knuckle taps on wood, then the door's slow creak. */
  knock(): void {
    this.burst(0.06, 0.5, "bandpass", 850);
    this.tone(140, 0.08, 0.25, "sine", 90);
    this.burst(0.06, 0.45, "bandpass", 780, undefined, 0.17);
    this.tone(130, 0.08, 0.22, "sine", 85, 0.17);
    // creak — a reedy saw sliding up as the hinge turns
    this.tone(95, 0.55, 0.05, "sawtooth", 210, 0.5);
  }

  /** Chest lid + a little treasure arpeggio. */
  chest(): void {
    this.tone(110, 0.12, 0.2, "sine", 70); // lid thunk
    this.tone(660, 0.16, 0.12, "triangle", undefined, 0.1);
    this.tone(880, 0.16, 0.12, "triangle", undefined, 0.22);
    this.tone(1320, 0.3, 0.12, "triangle", undefined, 0.34);
  }

  /** Item picked/foraged — one soft pluck. */
  pick(): void {
    this.tone(740, 0.14, 0.14, "triangle", 660);
  }

  /** A catch leaving the water. */
  splash(): void {
    this.burst(0.35, 0.4, "lowpass", 2800, 350);
    this.tone(320, 0.18, 0.18, "sine", 110, 0.03);
  }

  /** One footstep. Grass is a soft thud; stone a brighter tap. */
  step(surface: "grass" | "stone"): void {
    if (surface === "stone") {
      this.burst(0.05, 0.16, "bandpass", 1600);
      this.tone(190, 0.05, 0.05, "sine", 120);
    } else {
      this.burst(0.07, 0.14, "lowpass", 640, 220);
    }
  }

  /** A random little bird chirp (ambient). */
  bird(): void {
    const base = 2300 + Math.random() * 900;
    this.tone(base, 0.09, 0.045, "sine", base + 600);
    this.tone(base + 500, 0.1, 0.04, "sine", base - 200, 0.13);
    if (Math.random() < 0.5) this.tone(base + 200, 0.08, 0.035, "sine", base + 900, 0.28);
  }

  // ── Arcade: Zombie Waves combat ────────────────────────────────────────────

  /** Gunshot — layered noise (crack + body + boom), not a chip-tune blip.
   *  Every weapon has its OWN voice: snap pistol, hard revolver bark, light
   *  SMG chatter, punchy M4, deep shotgun boom, sniper crack with an echo. */
  shot(kind: "pistol" | "revolver" | "smg" | "m4" | "shotgun" | "sniper" = "pistol"): void {
    if (kind === "shotgun") {
      // deep, wide boom with a shell-rack rattle
      this.burst(0.05, 0.5, "bandpass", 2000, 900);
      this.burst(0.26, 0.65, "lowpass", 560, 80);
      this.tone(62, 0.18, 0.32, "sine", 40);
      this.burst(0.05, 0.14, "bandpass", 1200, 900, 0.28); // pump rack
    } else if (kind === "sniper") {
      // whip-crack + long booming echo trail
      this.burst(0.03, 0.6, "highpass", 3800, 2400);
      this.burst(0.14, 0.42, "lowpass", 900, 100);
      this.tone(85, 0.14, 0.26, "sine", 44);
      this.burst(0.4, 0.12, "lowpass", 500, 90, 0.1); // rolling echo
    } else if (kind === "m4") {
      // tight, punchy supersonic snap
      this.burst(0.035, 0.5, "bandpass", 3200, 1700);
      this.burst(0.1, 0.36, "lowpass", 820, 140);
      this.tone(105, 0.08, 0.18, "sine", 58);
    } else if (kind === "smg") {
      // light rapid chatter
      this.burst(0.025, 0.36, "bandpass", 2900, 1600);
      this.burst(0.06, 0.24, "lowpass", 760, 180);
      this.tone(130, 0.05, 0.12, "sine", 74);
    } else if (kind === "revolver") {
      // heavy magnum BARK with cylinder ring
      this.burst(0.045, 0.58, "bandpass", 2200, 1000);
      this.burst(0.2, 0.5, "lowpass", 640, 90);
      this.tone(72, 0.15, 0.28, "sine", 42);
      this.tone(1800, 0.12, 0.05, "triangle", 1500, 0.04); // metallic ring
    } else {
      // pistol: snap + short body + sub thump
      this.burst(0.035, 0.5, "bandpass", 2600, 1300);
      this.burst(0.11, 0.38, "lowpass", 800, 130);
      this.tone(90, 0.09, 0.2, "sine", 48);
    }
  }

  /** A bolt landing in something undead — wet thud. */
  zombieHit(): void {
    this.burst(0.08, 0.35, "lowpass", 700, 180);
    this.tone(120, 0.09, 0.16, "sine", 70);
  }

  /** A zombie going down for good — descending groan. */
  zombieDie(): void {
    this.tone(160, 0.5, 0.14, "sawtooth", 55);
    this.burst(0.3, 0.2, "lowpass", 500, 120, 0.05);
  }

  /** The player taking a bite — dull body thump + a dissonant sting. */
  hurt(): void {
    this.burst(0.1, 0.4, "lowpass", 420, 140);
    this.tone(233, 0.16, 0.12, "square", 180, 0.02);
  }

  /** A new wave rolling in — two low horn notes. */
  waveHorn(): void {
    this.tone(98, 0.5, 0.16, "sawtooth", 96);
    this.tone(147, 0.6, 0.14, "sawtooth", 144, 0.35);
  }

  // ── Arcade: run modes + shared moments ──────────────────────────────────────

  /** Victory fanfare — a bright rising arpeggio with a shimmer off the top. */
  fanfare(): void {
    this.tone(523, 0.16, 0.14, "triangle"); // C5
    this.tone(659, 0.16, 0.14, "triangle", undefined, 0.13); // E5
    this.tone(784, 0.18, 0.14, "triangle", undefined, 0.26); // G5
    this.tone(1047, 0.42, 0.15, "triangle", undefined, 0.4); // C6 held
    this.tone(2093, 0.3, 0.06, "sine", 1568, 0.46);
  }

  /** Defeat — a low minor sting sagging downward. Dying must not sound like loot. */
  deathSting(): void {
    this.tone(220, 0.5, 0.14, "sawtooth", 165);
    this.tone(131, 0.8, 0.12, "sawtooth", 110, 0.18);
    this.burst(0.5, 0.2, "lowpass", 300, 90, 0.1);
  }

  /** Checkpoint registered — a bright, unmistakable double ding. */
  checkpoint(): void {
    this.tone(1175, 0.12, 0.13, "triangle");
    this.tone(1568, 0.22, 0.13, "triangle", undefined, 0.11);
  }

  /** The run arms — one clean GO beep. */
  go(): void {
    this.tone(880, 0.09, 0.12, "square");
    this.tone(1320, 0.2, 0.13, "square", undefined, 0.1);
  }

  /** Landing after a fall — a soft thud, heavier for a long drop. */
  land(hard: boolean): void {
    if (hard) {
      this.burst(0.14, 0.4, "lowpass", 320, 110);
      this.tone(90, 0.16, 0.16, "sine", 60, 0.01);
    } else {
      this.burst(0.09, 0.22, "lowpass", 520, 200);
    }
  }

  /** Mag out — the reload begins. */
  reloadStart(): void {
    this.burst(0.04, 0.3, "bandpass", 1900);
    this.tone(240, 0.06, 0.08, "square", 190, 0.02);
  }

  /** Mag seated — the reload completes. */
  reloadEnd(): void {
    this.burst(0.05, 0.35, "bandpass", 1400);
    this.tone(340, 0.07, 0.1, "square", 300, 0.03);
  }

  /** Trigger pulled on an empty gun — a dry click. */
  dryFire(): void {
    this.burst(0.03, 0.25, "bandpass", 2400);
  }

  /** Wave cleared — two quick notes of relief before the next horn. */
  waveClear(): void {
    this.tone(659, 0.14, 0.12, "triangle");
    this.tone(988, 0.28, 0.12, "triangle", undefined, 0.12);
  }

  /** Run reset at the pad — a descending rewind blip. */
  runReset(): void {
    this.tone(880, 0.1, 0.1, "square", 660);
    this.tone(587, 0.16, 0.1, "square", 440, 0.09);
  }

  /** An exploder going off — a real boom with a low tail. */
  boom(): void {
    this.burst(0.4, 0.6, "lowpass", 900, 120);
    this.tone(70, 0.55, 0.2, "sine", 40, 0.02);
    this.burst(0.25, 0.3, "bandpass", 2400, 400, 0.04); // debris crackle
  }

  /** A ledge giving way — stone cracking under your feet. */
  crack(): void {
    this.burst(0.08, 0.45, "bandpass", 2100);
    this.burst(0.12, 0.35, "bandpass", 1300, 500, 0.06);
    this.tone(120, 0.18, 0.12, "sine", 70, 0.08);
  }

  /** A headshot — one sharp high tick over the normal hit. */
  crit(): void {
    this.tone(1760, 0.08, 0.12, "square", 1560);
    this.tone(2350, 0.1, 0.08, "sine", undefined, 0.05);
  }

  /** Points spent — a till-style double clink (wall-buys, perks). */
  purchase(): void {
    this.tone(990, 0.09, 0.11, "triangle");
    this.tone(1320, 0.14, 0.11, "triangle", undefined, 0.09);
    this.burst(0.05, 0.2, "bandpass", 3200, undefined, 0.02);
  }

  /** A quarter-height milestone on the climb — a rising two-note glint, softer
   *  than the checkpoint ding (this is progress, not a save). */
  milestone(): void {
    this.tone(988, 0.1, 0.09, "triangle");
    this.tone(1480, 0.24, 0.1, "triangle", undefined, 0.1);
  }

  /** A sweeper arm cutting past your ears — a low airy whoosh. */
  whoosh(): void {
    this.burst(0.28, 0.22, "lowpass", 1400, 260);
  }

  /** A crusher head hitting the deck nearby — dull ground thud, gain by proximity. */
  slam(closeness = 1): void {
    const g = Math.max(0.1, Math.min(1, closeness));
    this.burst(0.18, 0.45 * g, "lowpass", 260, 90);
    this.tone(58, 0.2, 0.2 * g, "sine", 38, 0.01);
  }

  /** A combo kill — one blip that climbs a semitone ladder with the streak. */
  comboTick(step: number): void {
    const freq = 620 * Math.pow(2, Math.min(step, 14) / 12);
    this.tone(freq, 0.09, 0.1, "square", freq * 1.02);
  }

  /** Low-HP heartbeat — the classic lub-dub, all sub. */
  heartbeat(): void {
    this.tone(58, 0.11, 0.22, "sine", 44);
    this.tone(52, 0.13, 0.16, "sine", 40, 0.16);
  }

  /** A springboard launch — a quick coiled BOING rising with the player. */
  spring(): void {
    this.tone(160, 0.28, 0.18, "sawtooth", 520);
    this.tone(320, 0.2, 0.1, "triangle", 780, 0.03);
    this.burst(0.06, 0.2, "bandpass", 900, 1600);
  }

  /** A grenade leaving the hand — pin tick + a short throw whip. */
  nadeThrow(): void {
    this.tone(2400, 0.04, 0.08, "square", 2100);
    this.burst(0.12, 0.2, "lowpass", 1800, 500, 0.02);
  }

  /** The boss walks in — a detuned double growl under a horn blast. */
  bossRoar(): void {
    this.tone(55, 0.9, 0.2, "sawtooth", 42);
    this.tone(58.5, 0.9, 0.16, "sawtooth", 44); // beating detune — the dread
    this.tone(110, 0.55, 0.14, "sawtooth", 104, 0.15);
    this.burst(0.5, 0.18, "lowpass", 420, 100, 0.05);
  }
}

export const worldSfx = new WorldSfx();

// ── The climb wind ────────────────────────────────────────────────────────────
//
// A continuous filtered-noise loop whose gain and brightness track altitude:
// silent in the meadow, a thin whistle at the quarter marks, a real wind at the
// summit. One node graph, started when the climb mounts, retargeted smoothly —
// never rebuilt per frame.
class WindLoop {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private src: AudioBufferSourceNode | null = null;
  private active = false; // one context per life — stop() suspends, start() resumes

  start(): void {
    if (this.active || !worldSfx.enabled) return;
    if (this.ctx) {
      // resume the suspended loop — the looping source is still attached
      this.active = true;
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    // 2s of looped noise is plenty — the bandpass masks the seam
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 500;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    this.src = src;
    this.filter = filter;
    this.gain = gain;
    this.active = true;
  }

  /** 0 = ground, 1 = summit. Smoothly retargets loudness + whistle brightness.
   *  Tracks the sfx toggle LIVE: enabling mid-climb starts the loop, disabling
   *  mid-climb stills it — the wind never outlives the setting. */
  set(altitude: number): void {
    if (!worldSfx.enabled) {
      if (this.active) this.stop();
      return;
    }
    if (!this.active) this.start();
    const ctx = this.ctx;
    if (!ctx || !this.gain || !this.filter) return;
    if (ctx.state === "suspended") void ctx.resume();
    const a = Math.max(0, Math.min(1, altitude));
    const vol = a < 0.08 ? 0.0001 : 0.015 + a * a * 0.12; // silent until you actually leave the ground
    this.gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.4);
    this.filter.frequency.setTargetAtTime(420 + a * 900, ctx.currentTime, 0.5);
  }

  stop(): void {
    const ctx = this.ctx;
    if (!ctx || !this.active) return;
    this.active = false;
    this.gain?.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.2);
    // after the fade: SUSPEND, keep the graph — the next climb resumes it
    setTimeout(() => { if (!this.active) void ctx.suspend().catch(() => { /* closing */ }); }, 600);
  }
}

export const worldWind = new WindLoop();

// ── Zombie Waves music ────────────────────────────────────────────────────────
//
// A darker, driving loop for the graveyard: pulsing minor bass eighths, a
// kick-heavy beat, ticking hats and an occasional low arp. Hype without being
// exhausting — everything sits well under the sfx so shots still cut through.

const Z_BPM = 112;
const Z_BAR_S = (60 / Z_BPM) * 4;
// Em → C → G → D (roots, low register)
const Z_ROOTS = [82.41, 65.41, 98.0, 73.42];
const Z_ARP = [164.81, 196.0, 246.94, 329.63]; // E3 G3 B3 E4
// E natural minor, mid register — the lead line that arrives with the deep waves.
const Z_LEAD = [329.63, 392.0, 440.0, 493.88, 587.33, 659.25];
const Z_MASTER = 0.4;

export class ZombieMusic {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBarTime = 0;
  private bar = 0;
  private active = false; // one context per class life — stop() suspends, start() resumes
  // Live game state, written by the wave manager each frame (cheap setters) and
  // read at bar-schedule time: the LOOP ITSELF escalates with the fight.
  private intensity = 0; // 0..1, from the wave number
  private breather = false; // between waves — the beat thins out
  private duck = 1; // low-HP ducking multiplier

  get playing(): boolean {
    return this.active;
  }

  /** The manager reports the fight: wave drives layer intensity, breathers thin the beat. */
  setState(wave: number, breather: boolean): void {
    this.intensity = Math.min(1, wave / 8);
    if (breather !== this.breather) {
      this.breather = breather;
      this.retarget();
    }
  }

  /** Duck the whole loop (low HP) — 1 = full, ~0.45 = under the heartbeat. */
  setDuck(mul: number): void {
    if (Math.abs(mul - this.duck) < 0.01) return;
    this.duck = mul;
    this.retarget();
  }

  private retarget(): void {
    if (!this.ctx || !this.master) return;
    const target = Z_MASTER * this.duck * (this.breather ? 0.6 : 1);
    this.master.gain.setTargetAtTime(Math.max(0.0001, target), this.ctx.currentTime, 0.35);
  }

  start(): void {
    if (this.active) return;
    this.duck = 1;
    this.breather = false;
    if (this.ctx && this.master) {
      this.active = true;
      void this.ctx.resume();
      const t0 = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t0);
      this.master.gain.setValueAtTime(0.0001, t0);
      this.master.gain.exponentialRampToValueAtTime(Z_MASTER, t0 + 1.6);
      this.bar = 0;
      this.nextBarTime = t0 + 0.1;
      if (!this.timer) this.timer = setInterval(() => this.schedule(), 200);
      this.schedule();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.active = true;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(Z_MASTER, ctx.currentTime + 1.6);
    master.connect(ctx.destination);
    this.master = master;
    this.bar = 0;
    this.nextBarTime = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 200);
    this.schedule();
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    while (this.nextBarTime < ctx.currentTime + 1.2) {
      this.scheduleBar(ctx, this.master, this.nextBarTime, this.bar);
      this.nextBarTime += Z_BAR_S;
      this.bar++;
    }
  }

  private scheduleBar(ctx: AudioContext, out: GainNode, t: number, bar: number): void {
    const beat = Z_BAR_S / 4;
    const root = Z_ROOTS[bar % Z_ROOTS.length];
    // Snapshot the fight at schedule time — the next bar plays what the wave is.
    const heat = this.intensity;
    const calm = this.breather;

    // Kick on every beat — the drive. Breathers drop it: the pulse holds its
    // breath with you, then the next wave's first bar slams it back in.
    if (!calm) {
      for (let b = 0; b < 4; b++) {
        const kt = t + b * beat;
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(120, kt);
        o.frequency.exponentialRampToValueAtTime(38, kt + 0.1);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, kt);
        g.gain.exponentialRampToValueAtTime(0.5, kt + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, kt + 0.16);
        o.connect(g).connect(out);
        o.start(kt);
        o.stop(kt + 0.2);
      }
    }

    // Bass eighths — square through a lowpass, pumping the root.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    lp.connect(out);
    for (let e = 0; e < 8; e++) {
      const bt = t + e * (beat / 2);
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = e === 6 ? root * 1.5 : root; // a little walk at the tail
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, bt);
      g.gain.exponentialRampToValueAtTime(0.14, bt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, bt + beat * 0.42);
      o.connect(g).connect(lp);
      o.start(bt);
      o.stop(bt + beat * 0.5);
    }

    // Ticking hats — off-beats once the fight warms up (wave 2+), full 16ths in
    // the deep waves. Breathers go hat-less.
    if (!calm && heat > 0.15) {
      const sixteenths = heat > 0.7;
      for (let e = 0; e < (sixteenths ? 16 : 8); e++) {
        if (!sixteenths && e % 2 === 0) continue; // eighths: off-beats only
        if (sixteenths && e % 4 === 0) continue; // sixteenths: leave the downbeats to the kick
        const ht = t + e * (beat / (sixteenths ? 4 : 2));
        const len = Math.floor(ctx.sampleRate * 0.03);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.value = 6500;
        const g = ctx.createGain();
        g.gain.setValueAtTime(sixteenths && e % 2 === 0 ? 0.045 : 0.07, ht);
        g.gain.exponentialRampToValueAtTime(0.0001, ht + 0.03);
        src.connect(f).connect(g).connect(out);
        src.start(ht);
      }
    }

    // The brooding arp — every other bar early, every bar once it's serious.
    // It's the one layer a breather keeps: the graveyard never goes silent.
    if (bar % 2 === 1 || heat > 0.75 || calm) {
      for (let i = 0; i < 4; i++) {
        const at = t + i * (beat / 2) + beat;
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = Z_ARP[(i + bar) % Z_ARP.length];
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.055, at + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + 0.5);
      }
    }

    // The lead — arrives around wave 5: a sparse minor line, saw through a
    // mellow lowpass, deterministic off the bar index so it phrases rather
    // than wanders.
    if (!calm && heat > 0.55) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1400;
      lp.Q.value = 0.6;
      lp.connect(out);
      const notes = bar % 4 === 3 ? 3 : 2; // a longer phrase to close each 4-bar turn
      for (let i = 0; i < notes; i++) {
        const at = t + (i * 1.5 + 0.5) * beat;
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = Z_LEAD[(bar * 3 + i * 2) % Z_LEAD.length];
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.05, at + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, at + beat * 1.2);
        o.connect(g).connect(lp);
        o.start(at);
        o.stop(at + beat * 1.3);
      }
    }
  }

  stop(): void {
    const ctx = this.ctx;
    if (!ctx || !this.active) return;
    this.active = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const master = this.master;
    if (master) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    }
    setTimeout(() => { if (!this.active) void ctx.suspend().catch(() => { /* closing */ }); }, 800);
  }
}

export const zombieMusic = new ZombieMusic();

