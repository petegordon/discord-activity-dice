import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeThrow, buildProfile, loadProfile, saveProfile, shakeLevel, type PracticeThrow } from "../src/input/calibration";
import { ShakeTracker, type MotionSample, type ThrowProfile } from "../src/input/motion";

const HZ = 60;
const dt = 1000 / HZ;

function samples(from: number, to: number, fn: (t: number) => Partial<MotionSample>): MotionSample[] {
  const out: MotionSample[] = [];
  for (let t = from; t < to; t += dt) out.push({ t, ax: 0, ay: 0, az: 0, rot: 0, ...fn(t) });
  return out;
}

/** Accelerate along `a` for 100 ms, then brake for 100 ms: a throw that stops in the hand. */
const throwAlong = (start: number, a: [number, number, number]) =>
  samples(start, start + 260, (t) => {
    const k = t - start < 100 ? 1 : t - start < 200 ? -1 : 0;
    return { ax: k * a[0], ay: k * a[1], az: k * a[2] };
  });

/** Like the controller: stop at the flick, which is when the throw is read. */
function feed(tracker: ShakeTracker, list: MotionSample[]): boolean {
  for (const s of list) if (tracker.push(s)) return true;
  return false;
}

describe("analyzeThrow", () => {
  it("finds a push away from the player", () => {
    const t = analyzeThrow(throwAlong(0, [0, 0, -12]), 0)!;
    expect(t.dir[2]).toBeLessThan(-0.95);
    expect(t.speed).toBeGreaterThan(0.9);
    expect(t.peak).toBeCloseTo(12);
  });

  it("maps to screen space using orientation", () => {
    // Landscape at 90°: device +x is up the screen.
    const t = analyzeThrow(throwAlong(0, [10, 0, 0]), 90)!;
    expect(t.dir[1]).toBeGreaterThan(0.95);
  });

  it("ignores wobbles", () => {
    expect(analyzeThrow(samples(0, 500, () => ({ ax: 1, ay: -1 })), 0)).toBeNull();
    expect(analyzeThrow([], 0)).toBeNull();
  });
});

describe("buildProfile", () => {
  const up = (speed: number, peak: number, x = 0): PracticeThrow => {
    const l = Math.hypot(x, 1);
    return { dir: [x / l, 1 / l, 0], speed, peak };
  };

  it("averages consistent throws", () => {
    const r = buildProfile(6, [up(0.8, 10, 0.1), up(1, 12), up(1.2, 14, -0.1)]);
    expect("profile" in r).toBe(true);
    if (!("profile" in r)) return;
    expect(r.profile.forward[1]).toBeGreaterThan(0.99);
    expect(r.profile.throwSpeed).toBe(1);
    expect(r.profile.flickPeak).toBe(12);
    expect(r.profile.shakeLevel).toBe(6);
  });

  it("asks to redo a throw that went another way", () => {
    const sideways: PracticeThrow = { dir: [1, 0, 0], speed: 1, peak: 12 };
    expect(buildProfile(6, [up(1, 12), sideways, up(1, 12)])).toEqual({ redo: 1 });
  });
});

describe("shakeLevel", () => {
  it("reads typical shaking above the noise floor", () => {
    const level = shakeLevel(samples(0, 1000, (t) => ({ ax: 8 * Math.sin(t / 20) })));
    expect(level).toBeGreaterThan(3);
    expect(level).toBeLessThan(8);
    expect(shakeLevel([])).toBe(0);
  });
});

describe("ShakeTracker with a profile", () => {
  /** Someone who throws by flicking the phone up the screen, gently. */
  const gentleUp: ThrowProfile = { v: 1, forward: [0, 1, 0], flickPeak: 12, throwSpeed: 0.8, shakeLevel: 5 };
  /** A flick: accelerate, brake, then hold still long enough to count. */
  const flick = (start: number, a: [number, number, number]) => [
    ...throwAlong(start, a),
    ...samples(start + 260, start + 420, () => ({})),
  ];

  it("counts a gentle flick that the defaults ignore", () => {
    const plain = new ShakeTracker();
    expect(feed(plain, flick(0, [0, 12, 0]))).toBe(false);
    const tuned = new ShakeTracker();
    tuned.profile = gentleUp;
    expect(feed(tuned, flick(0, [0, 12, 0]))).toBe(true);
  });

  it("treats the calibrated direction as straight, and screen-right as right", () => {
    const tr = new ShakeTracker();
    tr.profile = gentleUp;
    feed(tr, flick(0, [0, 12, 0]));
    const straight = tr.throwInput(0);
    expect(Math.abs(straight.dir[0])).toBeLessThan(0.1);
    expect(straight.speed).toBeGreaterThan(0.7); // their usual throw is a strong throw

    const right = new ShakeTracker();
    right.profile = gentleUp;
    feed(right, flick(0, [5, 12, 0]));
    expect(right.throwInput(0).dir[0]).toBeGreaterThan(0.2);
  });

  it("reaches full shake energy with the player's own, gentler shaking", () => {
    const shake = (t: number) => ({ ax: 6.5 * Math.sin((t / 1000) * 2 * Math.PI * 6) });
    const plain = new ShakeTracker();
    feed(plain, samples(0, 800, shake));
    const tuned = new ShakeTracker();
    tuned.profile = gentleUp;
    feed(tuned, samples(0, 800, shake));
    expect(tuned.peakEnergy).toBeGreaterThan(plain.peakEnergy * 2);
  });
});

describe("profile storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips, rejects junk, and survives missing storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const p: ThrowProfile = { v: 1, forward: [0, 0.6, -0.8], flickPeak: 15, throwSpeed: 1.1, shakeLevel: 7 };
    saveProfile(p);
    expect(loadProfile()).toEqual(p);
    store.set("dice.throwProfile", JSON.stringify({ v: 1, forward: [1, 2], flickPeak: 1 }));
    expect(loadProfile()).toBeNull();
    saveProfile(null);
    expect(loadProfile()).toBeNull();

    vi.stubGlobal("localStorage", undefined);
    expect(loadProfile()).toBeNull();
    expect(() => saveProfile(p)).not.toThrow();
  });
});
