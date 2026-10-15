import { mag, NOISE_FLOOR, peakVelocity, toScreen, type MotionSample, type ThrowProfile, type Vec3 } from "./motion";

/**
 * Optional throw calibration: the player shakes once and throws "straight at
 * the table" a few times, and the ShakeTracker adapts to them (see
 * ThrowProfile). It only shapes how the dice tumble; results are still picked
 * by the host.
 */

export const PRACTICE_THROWS = 3;
/** A practice throw more than this far from the others' direction is redone. */
const MAX_SPREAD_DEG = 40;
/** Weaker than this isn't a throw, just a wobble. */
const MIN_PEAK = 5; // m/s²
const MIN_SPEED = 0.15; // m/s
const BEFORE_PEAK_MS = 350;
const AFTER_PEAK_MS = 150;

export type PracticeThrow = { dir: Vec3; speed: number; peak: number };

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const angleDeg = (a: Vec3, b: Vec3) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * One practice throw from the samples recorded while the player held the
 * button. Finds the sharpest moment and the fastest velocity around it, in
 * screen space. Null if it doesn't look like a throw.
 */
export function analyzeThrow(samples: readonly MotionSample[], screenAngle: number): PracticeThrow | null {
  if (samples.length < 3) return null;
  let peakIdx = 0;
  for (let i = 1; i < samples.length; i++) if (mag(samples[i]) > mag(samples[peakIdx])) peakIdx = i;
  const peak = mag(samples[peakIdx]);
  if (peak < MIN_PEAK) return null;
  const tp = samples[peakIdx].t;
  const window = samples.filter((s) => s.t >= tp - BEFORE_PEAK_MS && s.t <= tp + AFTER_PEAK_MS);
  const v = toScreen(peakVelocity(window), screenAngle);
  const speed = Math.hypot(...v);
  if (speed < MIN_SPEED) return null;
  return { dir: norm(v), speed, peak };
}

/** Typical shaking strength: the 75th percentile of acceleration above the noise floor. */
export function shakeLevel(samples: readonly MotionSample[]): number {
  const above = samples.map((s) => mag(s) - NOISE_FLOOR).filter((x) => x > 0);
  if (!above.length) return 0;
  const sorted = above.sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
}

const meanDir = (throws: readonly PracticeThrow[]) =>
  norm(throws.reduce<Vec3>((acc, t) => [acc[0] + t.dir[0], acc[1] + t.dir[1], acc[2] + t.dir[2]], [0, 0, 0]));

/**
 * Combine the practice throws. If the one furthest from the others' direction
 * is clearly off, returns its index so the player can redo it.
 */
export function buildProfile(shake: number, throws: readonly PracticeThrow[]): { profile: ThrowProfile } | { redo: number } {
  if (throws.length > 1) {
    const spread = throws.map((t, i) => angleDeg(t.dir, meanDir(throws.filter((_, j) => j !== i))));
    const worst = spread.indexOf(Math.max(...spread));
    if (spread[worst] > MAX_SPREAD_DEG) return { redo: worst };
  }
  const forward = meanDir(throws);
  return {
    profile: {
      v: 1,
      forward,
      flickPeak: median(throws.map((t) => t.peak)),
      throwSpeed: median(throws.map((t) => t.speed)),
      shakeLevel: shake,
    },
  };
}

const STORAGE_KEY = "dice.throwProfile";

function isProfile(x: unknown): x is ThrowProfile {
  const p = x as ThrowProfile;
  return (
    !!p &&
    p.v === 1 &&
    Array.isArray(p.forward) &&
    p.forward.length === 3 &&
    p.forward.every(Number.isFinite) &&
    [p.flickPeak, p.throwSpeed, p.shakeLevel].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  );
}

/** Per device, in this browser only. Missing or unreadable storage just means the defaults. */
export function loadProfile(): ThrowProfile | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return isProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: ThrowProfile | null) {
  try {
    if (profile) localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable; the profile still applies until the page closes
  }
}
