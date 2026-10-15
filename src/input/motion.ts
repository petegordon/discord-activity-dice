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
/** A flick must have moved the phone forward at least this fast (m/s), more forward than sideways. */
const FLICK_MIN_FORWARD = 0.5;
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
      // A hard final shake stroke then holding still looks the same; only a forward motion counts.
      const { forward, sideways } = this.tableVelocity();
      return forward >= FLICK_MIN_FORWARD && forward > Math.abs(sideways);
    }
    return false;
  }

  /** screen.orientation.angle, kept current by the controller. */
  screenAngle = 0;

  /**
   * Peak velocity mapped to the table: device axes rotated into screen axes
   * (the screen is rotated counter-clockwise by screenAngle relative to the
   * device), then pushing away (−Z) or up the screen (+Y) is forward.
   */
  private tableVelocity(screenAngle = this.screenAngle) {
    const [vx, vy, vz] = this.peakVelocity();
    const rad = (screenAngle * Math.PI) / 180;
    const sx = vx * Math.cos(rad) - vy * Math.sin(rad);
    const sy = vx * Math.sin(rad) + vy * Math.cos(rad);
    return { forward: Math.max(0, -vz) + Math.max(0, sy) * 0.6, sideways: sx };
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
  throwInput(screenAngle = this.screenAngle): ThrowInput {
    const { forward, sideways } = this.tableVelocity(screenAngle);
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

/** How much of the gravity estimate is kept per sample when calibrating the sign. */
const CALIBRATION_SMOOTHING = 0.9;
/** Gravity along "up the screen + out of the screen" must be at least this clear (m/s²) to decide the sign. */
const CALIBRATION_MIN = 5;

/**
 * Converts a DeviceMotionEvent into a sample, high-pass filtering gravity out
 * when the browser only provides accelerationIncludingGravity.
 *
 * Some browsers (iOS Safari, at least historically) report every axis with
 * the opposite sign from the spec, which flips left/right and forward/back.
 * Rather than guess from the user agent, the reader calibrates itself:
 * held the way you play, gravity per the spec reads up the screen (+y) and
 * out of it (+z). If it reads the other way, every axis is negated.
 */
export class MotionReader {
  /** +1 for spec axes, −1 for inverted ones. Starts as the spec until gravity says otherwise. */
  sign = 1;
  /** screen.orientation.angle, kept current by the controller. */
  screenAngle = 0;
  private gravity: [number, number, number] | null = null;
  private calibration: [number, number, number] | null = null;

  read(e: DeviceMotionEvent, t: number): MotionSample | null {
    const r = e.rotationRate;
    const rot = r ? Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0) : 0;
    const g = e.accelerationIncludingGravity;
    const hasG = !!g && g.x !== null && g.y !== null && g.z !== null;
    if (hasG) this.calibrate([g.x!, g.y!, g.z!]);
    const k = this.sign;

    const a = e.acceleration;
    if (a && a.x !== null && a.y !== null && a.z !== null) {
      return { t, ax: k * a.x, ay: k * a.y, az: k * a.z, rot };
    }
    if (!hasG) return null;
    const alpha = 0.8;
    const raw: [number, number, number] = [g!.x!, g!.y!, g!.z!];
    this.gravity = this.gravity ? (this.gravity.map((v, i) => alpha * v + (1 - alpha) * raw[i]) as [number, number, number]) : raw;
    return { t, ax: k * (raw[0] - this.gravity[0]), ay: k * (raw[1] - this.gravity[1]), az: k * (raw[2] - this.gravity[2]), rot };
  }

  private calibrate(raw: [number, number, number]) {
    const c = CALIBRATION_SMOOTHING;
    this.calibration = this.calibration ? (this.calibration.map((v, i) => c * v + (1 - c) * raw[i]) as [number, number, number]) : raw;
    const [gx, gy, gz] = this.calibration;
    // "Up the screen" in device axes, using the same rotation as ShakeTracker.
    const rad = (this.screenAngle * Math.PI) / 180;
    const up = gx * Math.sin(rad) + gy * Math.cos(rad);
    const s = up + gz;
    if (Math.abs(s) >= CALIBRATION_MIN) this.sign = s > 0 ? 1 : -1;
  }
}
