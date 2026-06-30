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

  get playing(): boolean {
    return this.ctx !== null;
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
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

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
    if (!ctx) return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const master = this.master;
    if (master) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
    }
    const toClose = ctx;
    setTimeout(() => { void toClose.close().catch(() => { /* already closed */ }); }, 1000);
    this.ctx = null;
    this.master = null;
    this.bus = null;
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
}

export const worldSfx = new WorldSfx();

