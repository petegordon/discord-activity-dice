import type { Faces } from "../game/rules";
import type { BodyInit, RollPlan, ThrowInput } from "../net/protocol";
import { normalize, type Quat, type Vec3 } from "./faces";
import { simulate } from "./physics";
import { HAND_SPREAD, HAND_Y, HAND_Z } from "./table";

export type Rand = () => number;

/** Uniform [0, 1) from the platform CSPRNG. */
export const secureRandom: Rand = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
};

/** Die value 1..6 (bias from the 32-bit source is ~1e-9, negligible). */
export function fairD6(rand: Rand = secureRandom): number {
  return 1 + Math.floor(rand() * 6);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const jitter = (rand: Rand, amount: number) => (rand() * 2 - 1) * amount;

/** Uniformly random rotation (Shoemake). */
export function randomQuat(rand: Rand): Quat {
  const u1 = rand(), u2 = rand() * Math.PI * 2, u3 = rand() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return normalize([a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)]);
}

function randomUnit(rand: Rand): Vec3 {
  const z = rand() * 2 - 1;
  const t = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(t), r * Math.sin(t), z];
}

/**
 * Turns a (normalised) throw into initial body states. The gesture sets the
 * overall direction, speed and spin; the host's randomness sets everything
 * else, so a practiced flick can't steer the outcome.
 */
export function bodiesForThrow(input: ThrowInput, rand: Rand): [BodyInit, BodyInit] {
  const baseAngle = Math.atan2(input.dir[0], input.dir[1]);
  const make = (side: -1 | 1): BodyInit => {
    const angle = baseAngle + jitter(rand, 0.12);
    const speed = lerp(14, 30, input.speed) * (1 + jitter(rand, 0.08));
    const spin = lerp(8, 32, input.spin) * (1 + jitter(rand, 0.25));
    const axis = randomUnit(rand);
    return {
      pos: [side * HAND_SPREAD * 0.5 + jitter(rand, 0.05), HAND_Y + jitter(rand, 0.2), HAND_Z + jitter(rand, 0.2)],
      quat: randomQuat(rand),
      vel: [Math.sin(angle) * speed, lerp(3, 9, rand()), -Math.cos(angle) * speed],
      angVel: [axis[0] * spin, axis[1] * spin, axis[2] * spin],
    };
  };
  return [make(-1), make(1)];
}

/**
 * Host side: choose fair faces and a throw that lands both dice flat.
 * Faces are independent of the physics; clients rotate the dice meshes so the
 * chosen faces end up on top (see roller.ts).
 */
export function planRoll(rollId: string, shooter: string, input: ThrowInput, rand: Rand = secureRandom): RollPlan & { frameCount: number } {
  const faces: Faces = [fairD6(rand), fairD6(rand)];
  let best: { bodies: [BodyInit, BodyInit]; frameCount: number; flat: number } | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const bodies = bodiesForThrow(input, rand);
    const sim = simulate(bodies);
    const flat = Math.min(...sim.flatness);
    if (!best || flat > best.flat) best = { bodies, frameCount: sim.frameCount, flat };
    if (flat > 0.995) break;
  }
  return { rollId, shooter, faces, bodies: best!.bodies, frameCount: best!.frameCount };
}
