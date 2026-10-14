import { describe, expect, it } from "vitest";
import { ShakeTracker, SHAKE_TO_THROW, type MotionSample } from "../src/input/motion";
import { normalizeThrow, MIN_SPEED } from "../src/input/throw";

const HZ = 60;
const dt = 1000 / HZ;

/** Feed samples from `fn(tMs)`; returns the time of the first flick detection, if any. */
function feed(tracker: ShakeTracker, from: number, to: number, fn: (t: number) => Partial<MotionSample>): number | null {
  let hit: number | null = null;
  for (let t = from; t < to; t += dt) {
    const s = { t, ax: 0, ay: 0, az: 0, rot: 0, ...fn(t) };
    if (tracker.push(s) && hit === null) hit = t;
  }
  return hit;
}

const shake = (t: number) => ({ ax: 16 * Math.sin((t / 1000) * 2 * Math.PI * 6), ay: 6 * Math.cos((t / 1000) * 2 * Math.PI * 6), rot: 400 });

describe("ShakeTracker", () => {
  it("stays calm for sensor noise", () => {
    const tr = new ShakeTracker();
    feed(tr, 0, 2000, () => ({ ax: (Math.random() - 0.5) * 1.5, ay: (Math.random() - 0.5) * 1.5 }));
    expect(tr.energy).toBeLessThan(0.05);
    expect(tr.peakEnergy).toBeLessThan(SHAKE_TO_THROW);
  });

  it("builds energy while shaking, without mistaking it for a flick", () => {
    const tr = new ShakeTracker();
    const flick = feed(tr, 0, 3000, shake);
    expect(flick).toBeNull();
    expect(tr.energy).toBeGreaterThan(0.3);
    expect(tr.peakEnergy).toBeGreaterThan(SHAKE_TO_THROW);
  });

  it("detects a flick: a hard spike followed by stillness", () => {
    const tr = new ShakeTracker();
    feed(tr, 0, 1000, shake);
    // Forward push away from the player (−Z), then a hard stop, then still.
    const flick = feed(tr, 1000, 1600, (t) => {
      if (t < 1080) return { az: -30 };
      if (t < 1130) return { az: 28 };
      return {};
    });
    expect(flick).not.toBeNull();
    expect(flick! - 1130).toBeGreaterThanOrEqual(100);
    expect(flick! - 1130).toBeLessThan(200);
  });

  it("turns a forward push into a forward throw", () => {
    const tr = new ShakeTracker();
    feed(tr, 0, 600, shake);
    feed(tr, 600, 760, (t) => (t < 700 ? { az: -25 } : {}));
    const input = tr.throwInput(0);
    expect(input.source).toBe("motion");
    expect(input.dir[1]).toBeGreaterThan(0.85);
    expect(input.speed).toBeGreaterThan(0.6);
  });

  it("maps a sideways push using screen orientation", () => {
    const tr = new ShakeTracker();
    // Landscape (90°): device +Y points to the player's left... a push along device −Y reads as rightward.
    feed(tr, 0, 160, (t) => (t < 100 ? { ay: -25, az: -10 } : {}));
    const portrait = tr.throwInput(0);
    const landscape = tr.throwInput(90);
    expect(Math.abs(portrait.dir[0])).toBeLessThan(0.2);
    expect(Math.abs(landscape.dir[0])).toBeGreaterThan(0.5);
  });
});

describe("normalizeThrow", () => {
  it("survives garbage", () => {
    const t = normalizeThrow({ dir: [NaN, Infinity] as never, speed: -5, spin: 99, source: "evil" as never });
    expect(t.dir.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...t.dir)).toBeCloseTo(1, 6);
    expect(t.speed).toBe(MIN_SPEED);
    expect(t.spin).toBe(1);
    expect(t.source).toBe("button");
    expect(normalizeThrow(null).dir).toEqual([0, 1]);
  });

  it("never throws backwards or too far sideways", () => {
    for (const dir of [[0, -1], [1, 0], [-1, 0.01], [1, -1]] as [number, number][]) {
      const t = normalizeThrow({ dir, speed: 0.5, spin: 0.5, source: "flick" });
      expect(t.dir[1]).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(Math.hypot(...t.dir)).toBeCloseTo(1, 6);
    }
  });
});
