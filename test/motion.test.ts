import { describe, expect, it } from "vitest";
import { MotionReader, ShakeTracker, SHAKE_TO_THROW, type MotionSample } from "../src/input/motion";
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

  it("maps device axes to the table using screen orientation", () => {
    // Landscape at 90°: the device's +Y axis points to the player's left, +X points up the screen.
    const left = new ShakeTracker();
    feed(left, 0, 160, (t) => (t < 100 ? { ay: 25, az: -10 } : {}));
    expect(Math.abs(left.throwInput(0).dir[0])).toBeLessThan(0.2);
    expect(left.throwInput(90).dir[0]).toBeLessThan(-0.5);

    const up = new ShakeTracker();
    feed(up, 0, 160, (t) => (t < 100 ? { ax: 25 } : {}));
    const t = up.throwInput(90);
    expect(t.dir[1]).toBeGreaterThan(0.9); // up the landscape screen is forward
  });

  it("does not treat a hard sideways stroke followed by stillness as a flick", () => {
    const tr = new ShakeTracker();
    feed(tr, 0, 1000, shake);
    const flick = feed(tr, 1000, 1600, (t) => (t < 1060 ? { ax: 30 } : t < 1110 ? { ax: -28 } : {}));
    expect(flick).toBeNull();
  });
});

describe("MotionReader", () => {
  type V = [number, number, number];
  const ev = (acc: V, grav: V) =>
    ({
      acceleration: { x: acc[0], y: acc[1], z: acc[2] },
      accelerationIncludingGravity: { x: acc[0] + grav[0], y: acc[1] + grav[1], z: acc[2] + grav[2] },
      rotationRate: null,
    }) as unknown as DeviceMotionEvent;

  /** A phone held at a typical playing angle, per the spec: gravity reads up the screen and out of it. */
  const held: V = [0, 6.9, 6.9];

  it("passes spec-oriented readings through unchanged", () => {
    const r = new MotionReader();
    for (let i = 0; i < 20; i++) r.read(ev([0, 0, 0], held), i * 16);
    expect(r.sign).toBe(1);
    expect(r.read(ev([3, 0, -2], held), 400)).toMatchObject({ ax: 3, az: -2 });
  });

  it("flips every axis on a device that reports them inverted (iOS Safari)", () => {
    const r = new MotionReader();
    const inverted: V = [0, -6.9, -6.9];
    for (let i = 0; i < 20; i++) r.read(ev([0, 0, 0], inverted), i * 16);
    expect(r.sign).toBe(-1);
    // A push to the right reads as −x there; after the flip it's +x like everywhere else.
    expect(r.read(ev([-3, 0, 2], inverted), 400)).toMatchObject({ ax: 3, az: -2 });
  });

  it("uses screen orientation to find 'up', and keeps its last answer when gravity is ambiguous", () => {
    const r = new MotionReader();
    r.screenAngle = 90; // landscape: device +x is up the screen
    for (let i = 0; i < 20; i++) r.read(ev([0, 0, 0], [-9.6, 0, -1]), i * 16);
    expect(r.sign).toBe(-1);
    for (let i = 0; i < 40; i++) r.read(ev([0, 0, 0], [0, 9.8, -9.8]), 400 + i * 16); // up + out cancel out
    expect(r.sign).toBe(-1);
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
