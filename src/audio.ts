const MUTE_KEY = "dice.muted";

/**
 * Synthesised dice sounds (no audio files): clacks for dice rattling in the
 * hand and knocks for impacts on the felt, rails and each other.
 */
export class DiceAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private lastRattle = 0;
  muted: boolean;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(MUTE_KEY);
    } catch {
      // storage unavailable
    }
    this.muted = stored === "1";
  }

  /** Call from a user gesture; browsers keep audio suspended until then. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      const len = Math.floor(this.ctx.sampleRate * 0.25);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      // storage unavailable
    }
  }

  /** Call every frame/tick while shaking; plays clacks at a rate that rises with intensity. */
  rattle(intensity: number) {
    const now = performance.now();
    if (intensity < 0.08 || now - this.lastRattle < 160 - intensity * 110) return;
    this.lastRattle = now;
    this.click(2600 + Math.random() * 1800, 0.05 + intensity * 0.18, 0.035);
  }

  impact(strength: number, withDie: boolean) {
    const gain = Math.min(0.7, 0.06 + strength / 40);
    if (withDie) this.click(3200 + Math.random() * 800, gain, 0.04);
    else this.click(700 + Math.random() * 500 + strength * 30, gain, 0.07);
  }

  private click(freq: number, gain: number, dur: number) {
    if (this.muted || !this.ctx || !this.noise || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = 3;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(env).connect(ctx.destination);
    src.start(t, Math.random() * 0.15, dur + 0.02);
  }
}
