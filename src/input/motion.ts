import type { ThrowInput } from "../net/protocol";
import { MIN_SPEED, normalizeThrow } from "./throw";

/** One devicemotion reading in the device frame, gravity removed (m/s²). */
export type MotionSample = {
  /** ms */
  t: number;
  ax: number;
  ay: number;
  az: number;
  /** Rotation rate magnitude, deg/s (0 if no gyroscope). */
  rot: number;
};

const NOISE_FLOOR = 1.5; // m/s²; hand tremor and sensor noise
const ENERGY_SCALE = 18; // m/s² of sustained shaking that reads as full energy
const ENERGY_RISE = 0.25;
const ENERGY_FALL = 0.06;
const WINDOW_MS = 320;
const FLICK_PEAK = 22; // m/s²; harder than typical shaking
const FLICK_QUIET = 4; // m/s²
const FLICK_QUIET_MS = 110;
const FLICK_MAX_GAP_MS = 260;
/** Release velocity (m/s) that reads as a full-speed throw. */
const FULL_SPEED = 2.2;
const FULL_SPIN = 900; // deg/s
/** Shaking at least this much during a hold makes a release count as a throw. */
export const SHAKE_TO_THROW = 0.12;

const mag = (s: MotionSample) => Math.hypot(s.ax, s.ay, s.az);

/**
 * Turns raw motion into shake energy (for rattling and broadcasting) and
 * detects throws:
 * - flick: a sharp spike followed by stillness (shaking never goes still), or
 * - release: lifting the finger after shaking.
 */
export class ShakeTracker {
  /** 0..1, smoothed. */
  energy = 0;
  /** Highest energy seen during the current hold. */
  peakEnergy = 0;
  private window: MotionSample[] = [];
  private spikeAt = -Infinity;
  private quietSince = -Infinity;

  reset() {
    this.energy = 0;
    this.peakEnergy = 0;
    this.window = [];
    this.spikeAt = -Infinity;
    this.quietSince = -Infinity;
  }

  /** Returns true when this sample completes a flick. */
  push(s: MotionSample): boolean {
    this.window.push(s);
    while (this.window.length && s.t - this.window[0].t > WINDOW_MS) this.window.shift();

    const m = mag(s);
    const level = Math.min(1, Math.max(0, m - NOISE_FLOOR) / ENERGY_SCALE);
    this.energy += (level - this.energy) * (level > this.energy ? ENERGY_RISE : ENERGY_FALL);
    this.peakEnergy = Math.max(this.peakEnergy, this.energy);

    if (m >= FLICK_PEAK) {
      this.spikeAt = s.t;
      this.quietSince = -Infinity;
      return false;
    }
    if (m < FLICK_QUIET) {
      if (this.quietSince === -Infinity) this.quietSince = s.t;
    } else {
      this.quietSince = -Infinity;
    }
    const recentSpike = this.quietSince - this.spikeAt >= 0 && this.quietSince - this.spikeAt <= FLICK_MAX_GAP_MS;
    if (recentSpike && s.t - this.quietSince >= FLICK_QUIET_MS) {
      this.spikeAt = -Infinity;
      return true;
    }
    return false;
  }

  /** Peak velocity reached within the recent window, integrated from rest. */
  private peakVelocity(): [number, number, number] {
    let vx = 0, vy = 0, vz = 0;
    let best: [number, number, number] = [0, 0, 0];
    let bestMag = 0;
    for (let i = 1; i < this.window.length; i++) {
      const a = this.window[i - 1];
      const b = this.window[i];
      const dt = Math.min(0.05, Math.max(0, (b.t - a.t) / 1000));
      vx += ((a.ax + b.ax) / 2) * dt;
      vy += ((a.ay + b.ay) / 2) * dt;
      vz += ((a.az + b.az) / 2) * dt;
      const m = Math.hypot(vx, vy, vz);
      if (m > bestMag) {
        bestMag = m;
        best = [vx, vy, vz];
      }
    }
    return best;
  }

  /**
   * The throw implied by the recent motion. `screenAngle` is
   * screen.orientation.angle, used to map device axes to the table.
   * Phone held facing the player: pushing it away (−Z) or up (+Y) is forward.
   */
  throwInput(screenAngle = 0): ThrowInput {
    const [vx, vy, vz] = this.peakVelocity();
    const rad = (-screenAngle * Math.PI) / 180;
    const sx = vx * Math.cos(rad) - vy * Math.sin(rad);
    const sy = vx * Math.sin(rad) + vy * Math.cos(rad);
    const forward = Math.max(0, -vz) + Math.max(0, sy) * 0.6;
    const sideways = sx;
    const speedRaw = Math.hypot(forward, sideways) / FULL_SPEED;
    const rot = this.window.reduce((m, s) => Math.max(m, s.rot), 0);
    const spin = rot > 0 ? rot / FULL_SPIN : this.peakEnergy;
    return normalizeThrow({
      dir: [sideways, Math.max(forward, 0.2)],
      speed: Math.max(speedRaw, MIN_SPEED + this.peakEnergy * 0.5),
      spin: Math.max(spin, this.peakEnergy),
      source: "motion",
    });
  }
}

/**
 * Converts a DeviceMotionEvent into a sample, high-pass filtering gravity out
 * when the browser only provides accelerationIncludingGravity.
 */
export class MotionReader {
  private gravity: [number, number, number] | null = null;

  read(e: DeviceMotionEvent, t: number): MotionSample | null {
    const r = e.rotationRate;
    const rot = r ? Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0) : 0;
    const a = e.acceleration;
    if (a && a.x !== null && a.y !== null && a.z !== null) {
      return { t, ax: a.x, ay: a.y, az: a.z, rot };
    }
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.y === null || g.z === null) return null;
    const alpha = 0.8;
    const raw: [number, number, number] = [g.x, g.y, g.z];
    this.gravity = this.gravity ? (this.gravity.map((v, i) => alpha * v + (1 - alpha) * raw[i]) as [number, number, number]) : raw;
    return { t, ax: raw[0] - this.gravity[0], ay: raw[1] - this.gravity[1], az: raw[2] - this.gravity[2], rot };
  }
}
