import { describe, expect, it } from "vitest";
import {
  CUBE_ROTATIONS,
  FACE_NORMALS,
  correctionFor,
  multiply,
  rotate,
  settleFlat,
  topFace,
  axisAngle,
  type Quat,
} from "../src/dice/faces";
import { simulate } from "../src/dice/physics";
import { bodiesForThrow, planRoll, randomQuat } from "../src/dice/plan";
import { preparePlayback } from "../src/dice/roller";
import { buttonThrow } from "../src/input/throw";
import { TABLE_LENGTH, TABLE_WIDTH } from "../src/dice/table";

/** Small deterministic PRNG for reproducible tests. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("face layout", () => {
  it("opposite faces sum to 7", () => {
    for (let v = 1; v <= 6; v++) {
      const n = FACE_NORMALS[v];
      const opp = FACE_NORMALS[7 - v];
      expect(n.map((c, i) => c + opp[i])).toEqual([0, 0, 0]);
    }
  });

  it("has exactly 24 cube rotations", () => {
    expect(CUBE_ROTATIONS).toHaveLength(24);
  });

  it("detects the top face", () => {
    expect(topFace([0, 0, 0, 1]).value).toBe(2);
    expect(topFace(axisAngle([0, 0, 1], Math.PI / 2)).value).toBe(1);
  });
});

describe("correctionFor", () => {
  it("makes every landed face show every desired face, in all 4 variants", () => {
    const rand = mulberry32(1);
    for (let landed = 1; landed <= 6; landed++) {
      for (let desired = 1; desired <= 6; desired++) {
        for (let pick = 0; pick < 4; pick++) {
          // A body orientation that has `landed` up, with random yaw.
          const yaw = axisAngle([0, 1, 0], rand() * Math.PI * 2);
          const body = (CUBE_ROTATIONS.map((r) => multiply(yaw, r)).find((q) => topFace(q).value === landed) as Quat);
          const mesh = multiply(body, correctionFor(landed, desired, pick));
          const top = topFace(mesh);
          expect(top.value).toBe(desired);
          expect(top.dot).toBeCloseTo(1, 6);
        }
      }
    }
  });
});

describe("settleFlat", () => {
  it("flattens a tilted die onto its highest face", () => {
    const tilted = multiply(axisAngle([1, 0, 0], 0.4), axisAngle([0, 0, 1], 0.3));
    const flat = settleFlat(tilted);
    expect(topFace(flat).value).toBe(topFace(tilted).value);
    expect(topFace(flat).dot).toBeCloseTo(1, 6);
  });

  it("returns random quaternions of unit length", () => {
    const rand = mulberry32(2);
    for (let i = 0; i < 50; i++) expect(Math.hypot(...randomQuat(rand))).toBeCloseTo(1, 9);
  });
});

describe("simulation", () => {
  it("is deterministic for the same throw", () => {
    const bodies = bodiesForThrow(buttonThrow(mulberry32(3)), mulberry32(4));
    const a = simulate(bodies);
    const b = simulate(bodies);
    expect(a.frameCount).toBe(b.frameCount);
    expect(Array.from(a.frames[0])).toEqual(Array.from(b.frames[0]));
  });

  it("keeps dice on the table and brings them to rest flat", () => {
    const rand = mulberry32(5);
    for (let i = 0; i < 30; i++) {
      const bodies = bodiesForThrow({ dir: [rand() - 0.5, 1], speed: rand(), spin: rand(), source: "flick" }, rand);
      const sim = simulate(bodies);
      const last = sim.frameCount - 1;
      for (const f of sim.frames) {
        const o = last * 7;
        expect(Math.abs(f[o])).toBeLessThan(TABLE_WIDTH / 2);
        expect(Math.abs(f[o + 2])).toBeLessThan(TABLE_LENGTH / 2);
        const q = Array.from(f.slice(o + 3, o + 7)) as Quat;
        expect(topFace(q).dot).toBeGreaterThan(0.99);
      }
      expect(sim.frameCount).toBeLessThan(6 * 60 + 20);
    }
  });

  it("plans rolls whose playback shows the chosen faces", () => {
    const rand = mulberry32(6);
    for (let i = 0; i < 10; i++) {
      const plan = planRoll(`roll-${i}`, "a", buttonThrow(rand), rand);
      const { frameCount, ...wire } = plan;
      const playback = preparePlayback(JSON.parse(JSON.stringify(wire)));
      expect(playback.sim.frameCount).toBe(frameCount);
      playback.sim.frames.forEach((f, die) => {
        const o = (playback.sim.frameCount - 1) * 7;
        const body = Array.from(f.slice(o + 3, o + 7)) as Quat;
        const shown = topFace(multiply(body, playback.corrections[die])).value;
        expect(shown).toBe(plan.faces[die]);
      });
    }
  });

  it("rotate keeps vectors unit length", () => {
    const q = randomQuat(mulberry32(7));
    expect(Math.hypot(...rotate(q, [0, 1, 0]))).toBeCloseTo(1, 9);
  });
});

describe("hand layout", () => {
  it("never starts the two dice overlapping or touching the floor/walls", async () => {
    const { DIE_SIZE, HAND_Y, HAND_Z, TABLE_LENGTH: L } = await import("../src/dice/table");
    const halfDiag = (DIE_SIZE * Math.sqrt(3)) / 2;
    const rand = mulberry32(8);
    for (let i = 0; i < 200; i++) {
      const [a, b] = bodiesForThrow(buttonThrow(rand), rand);
      expect(Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2])).toBeGreaterThan(halfDiag * 2);
      for (const d of [a, b]) {
        expect(d.pos[1]).toBeGreaterThan(halfDiag);
        expect(L / 2 - d.pos[2]).toBeGreaterThan(halfDiag);
      }
    }
    expect(HAND_Y).toBeGreaterThan(halfDiag);
    expect(HAND_Z).toBeLessThan(L / 2);
  });
});
