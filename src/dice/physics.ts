import * as CANNON from "cannon-es";
import type { BodyInit } from "../net/protocol";
import { settleFlat, slerp, topFace, type Quat } from "./faces";
import { DIE_SIZE, GRAVITY, TABLE_LENGTH, TABLE_WIDTH, WALL_HEIGHT } from "./table";

export const STEP = 1 / 120;
/** Frames are recorded every other physics step: 60 fps playback. */
export const FRAME_STEPS = 2;
export const FRAME_DT = STEP * FRAME_STEPS;
const MAX_SECONDS = 6;
/** Floats per die per frame: position xyz + quaternion xyzw. */
export const FRAME_STRIDE = 7;
const SETTLE_FRAMES = 18;
const FLAT_ENOUGH = 0.995;

export type Impact = { frame: number; die: number; strength: number; withDie: boolean };

export type SimResult = {
  /** frames[die] = Float32Array of frameCount * FRAME_STRIDE */
  frames: Float32Array[];
  frameCount: number;
  impacts: Impact[];
  /** Face value up on each die at rest (after any flattening). */
  landed: number[];
  /** How flat each die came to rest before flattening (1 = flat). */
  flatness: number[];
};

function createWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0), allowSleep: true });
  world.broadphase = new CANNON.NaiveBroadphase();
  (world.solver as CANNON.GSSolver).iterations = 20;

  const diceMat = new CANNON.Material("dice");
  const feltMat = new CANNON.Material("felt");
  const wallMat = new CANNON.Material("wall");
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat, feltMat, { friction: 0.35, restitution: 0.35 }));
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat, wallMat, { friction: 0.1, restitution: 0.6 }));
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat, diceMat, { friction: 0.2, restitution: 0.45 }));

  const floor = new CANNON.Body({ mass: 0, material: feltMat, shape: new CANNON.Plane() });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(floor);

  const halfW = TABLE_WIDTH / 2;
  const halfL = TABLE_LENGTH / 2;
  const thickness = 1;
  const walls: [number, number, number, number, number][] = [
    // x, z, halfX, halfZ  (box walls so fast dice can't tunnel through a plane)
    [0, -halfL - thickness, halfW + thickness * 2, thickness, 0],
    [0, halfL + thickness, halfW + thickness * 2, thickness, 0],
    [-halfW - thickness, 0, thickness, halfL + thickness * 2, 0],
    [halfW + thickness, 0, thickness, halfL + thickness * 2, 0],
  ];
  for (const [x, z, hx, hz] of walls) {
    const wall = new CANNON.Body({
      mass: 0,
      material: wallMat,
      shape: new CANNON.Box(new CANNON.Vec3(hx, WALL_HEIGHT / 2, hz)),
      position: new CANNON.Vec3(x, WALL_HEIGHT / 2, z),
    });
    world.addBody(wall);
  }
  // Lid, so a wild throw can't leave the table.
  world.addBody(
    new CANNON.Body({
      mass: 0,
      material: wallMat,
      shape: new CANNON.Box(new CANNON.Vec3(halfW + 2, thickness, halfL + 2)),
      position: new CANNON.Vec3(0, WALL_HEIGHT + thickness, 0),
    }),
  );
  return { world, diceMat };
}

/**
 * Runs a throw to rest and records every frame. Deterministic for a given
 * input on a given JS engine, so the same call is used both to validate a
 * throw (host) and to produce the animation that is played back (everyone).
 */
export function simulate(inits: readonly BodyInit[]): SimResult {
  const { world, diceMat } = createWorld();
  const half = DIE_SIZE / 2;
  const bodies = inits.map((init) => {
    const body = new CANNON.Body({
      mass: 1,
      material: diceMat,
      shape: new CANNON.Box(new CANNON.Vec3(half, half, half)),
      position: new CANNON.Vec3(...init.pos),
      quaternion: new CANNON.Quaternion(...init.quat),
      velocity: new CANNON.Vec3(...init.vel),
      angularVelocity: new CANNON.Vec3(...init.angVel),
      linearDamping: 0.08,
      angularDamping: 0.12,
      sleepSpeedLimit: 0.12,
      sleepTimeLimit: 0.2,
    });
    world.addBody(body);
    return body;
  });

  const maxFrames = Math.ceil(MAX_SECONDS / FRAME_DT) + 1;
  const frames = bodies.map(() => new Float32Array((maxFrames + SETTLE_FRAMES) * FRAME_STRIDE));
  const impacts: Impact[] = [];
  let frame = 0;
  const lastImpactFrame = bodies.map(() => -10);

  bodies.forEach((body, i) => {
    body.addEventListener("collide", (e: { body: CANNON.Body; contact: CANNON.ContactEquation }) => {
      const strength = Math.abs(e.contact.getImpactVelocityAlongNormal());
      if (strength < 1.2 || frame - lastImpactFrame[i] < 4) return;
      lastImpactFrame[i] = frame;
      impacts.push({ frame, die: i, strength, withDie: bodies.includes(e.body) });
    });
  });

  const record = () => {
    bodies.forEach((b, i) => {
      const o = frame * FRAME_STRIDE;
      const f = frames[i];
      f[o] = b.position.x; f[o + 1] = b.position.y; f[o + 2] = b.position.z;
      f[o + 3] = b.quaternion.x; f[o + 4] = b.quaternion.y; f[o + 5] = b.quaternion.z; f[o + 6] = b.quaternion.w;
    });
  };

  record();
  while (frame < maxFrames - 1) {
    for (let s = 0; s < FRAME_STEPS; s++) world.step(STEP);
    frame++;
    record();
    if (bodies.every((b) => b.sleepState === CANNON.Body.SLEEPING)) break;
  }

  // A die resting cocked against a wall or the other die gets eased flat so it
  // always reads as a clear face.
  const flatness: number[] = [];
  const landed: number[] = [];
  const endQuats: Quat[] = [];
  const flatQuats: Quat[] = [];
  bodies.forEach((b) => {
    const q: Quat = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
    const top = topFace(q);
    flatness.push(top.dot);
    landed.push(top.value);
    endQuats.push(q);
    flatQuats.push(top.dot < FLAT_ENOUGH ? settleFlat(q) : q);
  });
  if (flatness.some((d) => d < FLAT_ENOUGH)) {
    const base = frame;
    for (let k = 1; k <= SETTLE_FRAMES; k++) {
      frame = base + k;
      const t = k / SETTLE_FRAMES;
      const ease = t * t * (3 - 2 * t);
      bodies.forEach((b, i) => {
        const o = frame * FRAME_STRIDE;
        const f = frames[i];
        const q = slerp(endQuats[i], flatQuats[i], ease);
        f[o] = b.position.x;
        f[o + 1] = b.position.y + (half - b.position.y) * (flatness[i] < FLAT_ENOUGH ? ease : 0);
        f[o + 2] = b.position.z;
        f.set(q, o + 3);
      });
    }
  }

  const frameCount = frame + 1;
  return { frames: frames.map((f) => f.slice(0, frameCount * FRAME_STRIDE)), frameCount, impacts, landed, flatness };
}
